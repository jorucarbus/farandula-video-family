const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';
const JWT_EXPIRY = '7d';

// Password validation
function validatePassword(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
}

// Hash password
async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

// Compare password
async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Generate JWT token
function generateToken(userId, email) {
  return jwt.sign(
    { userId, email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

// Verify JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Signup handler
async function signup(email, password) {
  // Validate email
  if (!email || !email.includes('@')) {
    throw new Error('Invalid email format');
  }

  // Validate password
  const passwordError = validatePassword(password);
  if (passwordError) {
    throw new Error(passwordError);
  }

  // Hash password
  const passwordHash = await hashPassword(password);

  // Create user
  const user = await db.createUser(email, passwordHash);

  // Generate token
  const token = generateToken(user.id, user.email);

  return {
    user: { id: user.id, email: user.email },
    token,
  };
}

// Login handler
async function login(email, password) {
  // Get user
  const user = await db.getUserByEmail(email);
  if (!user) {
    throw new Error('Email or password incorrect');
  }

  // Compare password
  const isValid = await comparePassword(password, user.password_hash);
  if (!isValid) {
    throw new Error('Email or password incorrect');
  }

  // Generate token
  const token = generateToken(user.id, user.email);

  return {
    user: { id: user.id, email: user.email },
    token,
  };
}

// Middleware: extract user from token
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
}

module.exports = {
  validatePassword,
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  signup,
  login,
  requireAuth,
  JWT_SECRET,
};
