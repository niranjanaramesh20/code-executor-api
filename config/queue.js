const { Queue } = require("bullmq")
const redis = require("./redis")

const codeQueue = new Queue("code-execution", {
    connection: redis
})


module.exports = codeQueue
