const Redis = require("ioredis")

const publisher = new Redis(process.env.REDIS_URL)

const subscriber = new Redis (process.env.REDIS_URL)
module.exports = {
    publisher,
    subscriber
}
