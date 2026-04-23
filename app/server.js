const express = require('express');
const mongoose = require('mongoose');
const os = require('os');

const app = express();
app.use(express.json());

// Pull MongoDB connection string from Environment Variables
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/packages';

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

const PackageSchema = new mongoose.Schema({
  name: String,
  manager: String, // e.g., zypper, pacman, apt
  description: String
});

const Package = mongoose.model('Package', PackageSchema);

// --- API ROUTES ---
app.get('/api/packages', async (req, res) => {
  const packages = await Package.find();
  res.json({
    hostname: os.hostname(), // Shows which pod answered the request
    data: packages
  });
});

app.post('/api/packages', async (req, res) => {
  const newPackage = new Package(req.body);
  await newPackage.save();
  res.status(201).json(newPackage);
});

// Health check endpoint for Kubernetes probes
app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
