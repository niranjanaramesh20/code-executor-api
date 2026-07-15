const express = require("express")
const cors = require("cors")

const runRoutes = require("./routes/run")
const projectRoutes = require("./routes/projects")
const authRoutes = require("./routes/auth")

function createApp() {
    const app = express()

    app.use(cors())
    app.use(express.json({ limit: "200kb" }))
    app.get("/health", (req, res) => {
        res.status(200).json({ status: "ok" })
    })
    app.use(runRoutes)
    app.use(projectRoutes)
    app.use("/auth", authRoutes)

    app.use((err, req, res, next) => {
        if (err.type === "entity.too.large") {
            return res.status(413).json({ error: "Request body too large" })
        }
        if (err.type === "entity.parse.failed") {
            return res.status(400).json({ error: "Invalid JSON body" })
        }
        console.error(err)
        res.status(500).json({ error: "Internal server error" })
    })

    return app
}

module.exports = createApp
