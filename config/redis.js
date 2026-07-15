const Redis = require("ioredis")

const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
})

module.exports = redis
