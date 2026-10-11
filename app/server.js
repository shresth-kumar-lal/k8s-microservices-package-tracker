'use strict';

const express = require('express');
const mongoose = require('mongoose');
const os = require('node:os');
const fs = require('node:fs');
const client = require('prom-client');
const { validatePackageInput, parsePagination } = require('./validation');

const SECRET_FILE = process.env.MONGO_URI_FILE || '/vault/secrets/db-creds.json';
const PORT = Number(process.env.PORT || 3000);
const METRICS_PORT = Number(process.env.METRICS_PORT || 9090);
const RETRY_DELAY_MS = Number(process.env.DB_RETRY_DELAY_MS || 5000);
const REGISTER = new client.Registry();
REGISTER.setDefaultLabels({ service: 'package-tracker-api' });
client.collectDefaultMetrics({ register: REGISTER });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests handled by the package tracker API.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [REGISTER]
});
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [REGISTER]
});

const PackageSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
  manager: { type: String, required: true, trim: true, minlength: 1, maxlength: 40 },
  description: { type: String, trim: true, default: '', maxlength: 500 }
}, {
  timestamps: true,
  versionKey: false,
  strict: 'throw'
});
const Package = mongoose.models.Package || mongoose.model('Package', PackageSchema);

function getMongoURI() {
  if (fs.existsSync(SECRET_FILE)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    } catch (error) {
      throw new Error(`Could not parse Vault secret file ${SECRET_FILE}: ${error.message}`);
    }
    if (typeof parsed.MONGO_URI === 'string' && parsed.MONGO_URI.trim()) {
      return validateMongoURI(parsed.MONGO_URI.trim());
    }
    throw new Error(`Vault secret file ${SECRET_FILE} does not contain a non-empty MONGO_URI.`);
  }

  if (process.env.MONGO_URI) return validateMongoURI(process.env.MONGO_URI.trim());
  throw new Error(`Database URI missing: expected MONGO_URI in ${SECRET_FILE} or the MONGO_URI environment variable.`);
}

function validateMongoURI(uri) {
  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri)) {
    throw new Error('MONGO_URI must start with mongodb:// or mongodb+srv://.');
  }
  return uri;
}

function createApp({ packageModel = Package, isDatabaseReady = () => mongoose.connection.readyState === 1 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use((req, res, next) => {
    const stopTimer = httpRequestDuration.startTimer();
    res.on('finish', () => {
      // Use the matched route template, not arbitrary URL paths, to keep metric cardinality bounded.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const labels = { method: req.method, route, status_code: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      stopTimer(labels);
    });
    next();
  });

  app.get('/livez', (_req, res) => res.status(200).json({ status: 'alive' }));

  const readinessHandler = (_req, res) => {
    if (isDatabaseReady()) return res.status(200).json({ status: 'ready' });
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  };
  app.get('/readyz', readinessHandler);
  // Keep the old endpoint for compatibility; use /readyz in Kubernetes manifests.
  app.get('/health', readinessHandler);

  app.get('/api/packages', async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination.ok) return res.status(400).json({ error: pagination.error });

    const { page, pageSize, skip } = pagination.value;
    const [data, total] = await Promise.all([
      packageModel.find({}).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
      packageModel.countDocuments({})
    ]);

    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      hostname: os.hostname(),
      page,
      pageSize,
      total,
      data
    });
  });

  app.post('/api/packages', async (req, res) => {
    const validated = validatePackageInput(req.body);
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    const created = await packageModel.create(validated.value);
    return res.status(201).json(created);
  });

  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Express 5 forwards rejected async route-handler promises to this middleware.
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body contains invalid JSON.' });
    }
    if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.StrictModeError) {
      return res.status(400).json({ error: 'Package data failed validation.' });
    }
    console.error('Unhandled request error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

function createMetricsApp() {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', REGISTER.contentType);
    res.status(200).send(await REGISTER.metrics());
  });
  app.get('/livez', (_req, res) => res.status(200).send('OK'));
  return app;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectMongoWithRetry(uri, shouldStop = () => false) {
  while (!shouldStop()) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      console.log('Connected to MongoDB');
      return;
    } catch (error) {
      console.error(`MongoDB connection attempt failed: ${error.message}`);
      if (!shouldStop()) await sleep(RETRY_DELAY_MS);
    }
  }
}

async function main() {
  let stopping = false;
  let apiServer;
  let metricsServer;

  let mongoURI;
  try {
    mongoURI = getMongoURI();
  } catch (error) {
    console.error(`Startup configuration error: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  // Start HTTP immediately. Readiness remains 503 until MongoDB is connected;
  // liveness does not depend on the database and therefore won't restart-loop on DB outages.
  apiServer = createApp().listen(PORT, () => console.log(`API listening on port ${PORT}`));
  metricsServer = createMetricsApp().listen(METRICS_PORT, () => console.log(`Metrics listening on port ${METRICS_PORT}`));
  const connectionLoop = connectMongoWithRetry(mongoURI, () => stopping);

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; shutting down gracefully`);
    const closeServer = (server) => new Promise((resolve) => {
      if (!server) return resolve();
      server.close(resolve);
    });
    await Promise.all([closeServer(apiServer), closeServer(metricsServer)]);
    await mongoose.disconnect().catch((error) => console.error(`MongoDB shutdown error: ${error.message}`));
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  await connectionLoop;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal application error:', error);
    process.exitCode = 1;
  });
}

module.exports = { createApp, createMetricsApp, getMongoURI, connectMongoWithRetry, Package, REGISTER };
