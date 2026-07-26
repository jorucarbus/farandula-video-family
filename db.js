const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Initialize database schema
async function initializeDatabase() {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Job history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS job_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_id VARCHAR(255) NOT NULL,
        fecha TIMESTAMP DEFAULT NOW(),
        canal VARCHAR(255),
        duracion DECIMAL,
        video_name VARCHAR(255),
        status VARCHAR(50),
        UNIQUE(user_id, job_id)
      )
    `);

    console.log('✅ Database schema initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    throw error;
  }
}

// User queries
async function createUser(email, passwordHash) {
  const query = 'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at';
  try {
    const result = await pool.query(query, [email, passwordHash]);
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw new Error('Email already exists');
    }
    throw error;
  }
}

async function getUserByEmail(email) {
  const query = 'SELECT * FROM users WHERE email = $1';
  const result = await pool.query(query, [email]);
  return result.rows[0] || null;
}

async function getUserById(userId) {
  const query = 'SELECT id, email, created_at FROM users WHERE id = $1';
  const result = await pool.query(query, [userId]);
  return result.rows[0] || null;
}

// Job history queries
async function addJobToHistory(userId, jobId, canal, duracion = null, videoName = null, status = 'in_progress') {
  const query = `
    INSERT INTO job_history (user_id, job_id, canal, duracion, video_name, status)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id, job_id) DO UPDATE SET
      status = $6,
      duracion = COALESCE($4, job_history.duracion),
      video_name = COALESCE($5, job_history.video_name),
      fecha = NOW()
    RETURNING *
  `;
  const result = await pool.query(query, [userId, jobId, canal, duracion, videoName, status]);
  return result.rows[0];
}

async function getJobHistory(userId) {
  const query = `
    SELECT * FROM job_history
    WHERE user_id = $1
    ORDER BY fecha DESC
    LIMIT 50
  `;
  const result = await pool.query(query, [userId]);
  return result.rows;
}

async function getJobHistoryItem(userId, jobId) {
  const query = 'SELECT * FROM job_history WHERE user_id = $1 AND job_id = $2';
  const result = await pool.query(query, [userId, jobId]);
  return result.rows[0] || null;
}

async function updateJobHistory(userId, jobId, updates) {
  const allowedFields = ['canal', 'duracion', 'video_name', 'status'];
  const validUpdates = Object.keys(updates)
    .filter(key => allowedFields.includes(key))
    .reduce((acc, key) => {
      acc[key] = updates[key];
      return acc;
    }, {});

  if (Object.keys(validUpdates).length === 0) {
    throw new Error('No valid fields to update');
  }

  const setClause = Object.keys(validUpdates)
    .map((key, index) => `${key} = $${index + 3}`)
    .join(', ');

  const query = `
    UPDATE job_history
    SET ${setClause}, fecha = NOW()
    WHERE user_id = $1 AND job_id = $2
    RETURNING *
  `;

  const values = [userId, jobId, ...Object.values(validUpdates)];
  const result = await pool.query(query, values);
  return result.rows[0] || null;
}

// Test connection
async function testConnection() {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Database connection successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

module.exports = {
  pool,
  initializeDatabase,
  testConnection,
  // User queries
  createUser,
  getUserByEmail,
  getUserById,
  // Job history queries
  addJobToHistory,
  getJobHistory,
  getJobHistoryItem,
  updateJobHistory,
};
