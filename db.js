const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Aiven suele requerir SSL activado
    ssl: {
        rejectUnauthorized: false
    }
});

module.exports = pool;