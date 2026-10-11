'use strict';

const ALLOWED_PACKAGE_FIELDS = new Set(['name', 'manager', 'description']);

/** Validate and normalize the user-controlled package payload. */
function validatePackageInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const unknownFields = Object.keys(body).filter((key) => !ALLOWED_PACKAGE_FIELDS.has(key));
  if (unknownFields.length > 0) {
    return { ok: false, error: `Unknown field(s): ${unknownFields.join(', ')}.` };
  }

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return { ok: false, error: 'name is required and must be a non-empty string.' };
  }
  if (body.name.trim().length > 100) {
    return { ok: false, error: 'name must be at most 100 characters.' };
  }

  if (typeof body.manager !== 'string' || body.manager.trim().length === 0) {
    return { ok: false, error: 'manager is required and must be a non-empty string.' };
  }
  if (body.manager.trim().length > 40) {
    return { ok: false, error: 'manager must be at most 40 characters.' };
  }

  let description = '';
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      return { ok: false, error: 'description must be a string when provided.' };
    }
    description = body.description.trim();
    if (description.length > 500) {
      return { ok: false, error: 'description must be at most 500 characters.' };
    }
  }

  return {
    ok: true,
    value: {
      name: body.name.trim(),
      manager: body.manager.trim(),
      description
    }
  };
}

function parsePositiveInteger(rawValue, fallback, fieldName) {
  if (rawValue === undefined) return { ok: true, value: fallback };
  if (typeof rawValue !== 'string' || !/^[1-9]\d*$/.test(rawValue)) {
    return { ok: false, error: `${fieldName} must be a positive integer.` };
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, error: `${fieldName} is too large.` };
  }
  return { ok: true, value };
}

function parsePagination(query) {
  const parsedPage = parsePositiveInteger(query.page, 1, 'page');
  if (!parsedPage.ok) return parsedPage;

  const parsedPageSize = parsePositiveInteger(query.pageSize, 20, 'pageSize');
  if (!parsedPageSize.ok) return parsedPageSize;
  if (parsedPageSize.value > 100) {
    return { ok: false, error: 'pageSize must not exceed 100.' };
  }

  const skip = (parsedPage.value - 1) * parsedPageSize.value;
  if (!Number.isSafeInteger(skip)) {
    return { ok: false, error: 'page is too large.' };
  }

  return {
    ok: true,
    value: { page: parsedPage.value, pageSize: parsedPageSize.value, skip }
  };
}

module.exports = { validatePackageInput, parsePagination };
