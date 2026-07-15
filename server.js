const http = require("http")
require("dotenv").config()

const createApp = require("./app")
const initWebsocket = require("./services/websocket")

const PORT = process.env.PORT || 5000

const app = createApp()
const server = http.createServer(app)

initWebsocket(server)

server.listen(PORT, () => {
    console.log(`server running on port ${PORT}`)
})
