const {Pool} = require('pg')

const poolConfig = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === "true"
            ? { rejectUnauthorized: false }
            : undefined
    }
    : {
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD || "postgres",
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || "code_executor"
    }

const pool = new Pool(poolConfig)

pool.connect()
    .then(client => {
        console.log("Connected to PostgreSQL")
        client.release()
    }) 
    .catch(err => {
        console.error("PostgreSQL connection failed", err.message)
    })

module.exports = pool
