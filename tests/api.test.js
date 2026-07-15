const test = require("node:test")
const assert = require("node:assert/strict")
const bcrypt = require("bcrypt")
const jwt = require("jsonwebtoken")

process.env.JWT_SECRET = "test-secret"

const dbState = {
    users: [],
    projects: [],
    nextProjectId: 1
}

const queueState = {
    jobs: new Map(),
    addedJobs: []
}

const redisState = {
    values: new Map()
}

const mockPool = {
    async query(sql, params = []) {
        const normalizedSql = sql.replace(/\s+/g, " ").trim()

        if (normalizedSql.includes("SELECT id FROM users WHERE email = $1")) {
            const user = dbState.users.find(row => row.email === params[0])
            return {
                rowCount: user ? 1 : 0,
                rows: user ? [{ id: user.id }] : []
            }
        }

        if (normalizedSql.includes("INSERT INTO users")) {
            const user = {
                id: dbState.users.length + 1,
                username: params[0],
                email: params[1],
                password_hash: params[2]
            }
            dbState.users.push(user)
            return {
                rowCount: 1,
                rows: [{ id: user.id, username: user.username, email: user.email }]
            }
        }

        if (normalizedSql.includes("SELECT id, username, email, password_hash FROM users WHERE email = $1")) {
            const user = dbState.users.find(row => row.email === params[0])
            return {
                rowCount: user ? 1 : 0,
                rows: user ? [user] : []
            }
        }

        if (normalizedSql.includes("INSERT INTO projects")) {
            const project = {
                id: dbState.nextProjectId++,
                user_id: params[0],
                name: params[1],
                language: params[2],
                source_code: params[3]
            }
            dbState.projects.push(project)
            return { rowCount: 1, rows: [project] }
        }

        if (normalizedSql.includes("SELECT * FROM projects WHERE user_id = $1 ORDER BY id DESC")) {
            const rows = dbState.projects
                .filter(project => project.user_id === params[0])
                .sort((a, b) => b.id - a.id)
            return { rowCount: rows.length, rows }
        }

        if (normalizedSql.includes("SELECT * FROM projects WHERE id = $1 AND user_id = $2")) {
            const project = dbState.projects.find(row => row.id === Number(params[0]) && row.user_id === params[1])
            return {
                rowCount: project ? 1 : 0,
                rows: project ? [project] : []
            }
        }

        if (normalizedSql.includes("UPDATE projects SET")) {
            const project = dbState.projects.find(row => row.id === Number(params[3]) && row.user_id === params[4])
            if (!project) {
                return { rowCount: 0, rows: [] }
            }
            project.name = params[0]
            project.language = params[1]
            project.source_code = params[2]
            return { rowCount: 1, rows: [project] }
        }

        if (normalizedSql.includes("DELETE FROM projects WHERE id = $1 AND user_id = $2")) {
            const index = dbState.projects.findIndex(row => row.id === Number(params[0]) && row.user_id === params[1])
            if (index === -1) {
                return { rowCount: 0, rows: [] }
            }
            const [project] = dbState.projects.splice(index, 1)
            return { rowCount: 1, rows: [project] }
        }

        throw new Error(`Unexpected query: ${normalizedSql}`)
    }
}

const mockQueue = {
    async add(name, payload) {
        const id = String(queueState.addedJobs.length + 1)
        const job = { id, name, payload }
        queueState.addedJobs.push(job)
        queueState.jobs.set(id, job)
        return job
    },
    async getJob(id) {
        return queueState.jobs.get(id) || null
    }
}

const mockRedis = {
    async get(key) {
        return redisState.values.get(key) || null
    }
}

function mockModule(relativePath, exports) {
    const filename = require.resolve(relativePath)
    require.cache[filename] = {
        id: filename,
        filename,
        loaded: true,
        exports
    }
}

mockModule("../config/db", mockPool)
mockModule("../config/queue", mockQueue)
mockModule("../config/redis", mockRedis)

const createApp = require("../app")

function resetState() {
    dbState.users = []
    dbState.projects = []
    dbState.nextProjectId = 1
    queueState.jobs.clear()
    queueState.addedJobs = []
    redisState.values.clear()
}

async function withServer(callback) {
    const app = createApp()
    const server = app.listen(0, "127.0.0.1")

    await new Promise(resolve => server.once("listening", resolve))

    const { port } = server.address()
    const baseUrl = `http://127.0.0.1:${port}`

    try {
        await callback(baseUrl)
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve())
        })
    }
}

async function request(baseUrl, path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            "content-type": "application/json",
            ...(options.headers || {})
        }
    })

    const text = await response.text()
    const body = text ? JSON.parse(text) : null

    return { status: response.status, body }
}

function authHeader(user = { id: 1, email: "ada@example.com" }) {
    return {
        authorization: `Bearer ${jwt.sign(user, process.env.JWT_SECRET)}`
    }
}

test.beforeEach(resetState)

test("register normalizes input and does not return password hashes", async () => {
    await withServer(async baseUrl => {
        const response = await request(baseUrl, "/auth/register", {
            method: "POST",
            body: JSON.stringify({
                username: "  Ada  ",
                email: " ADA@Example.COM ",
                password: "StrongPass1!"
            })
        })

        assert.equal(response.status, 201)
        assert.deepEqual(response.body, {
            id: 1,
            username: "Ada",
            email: "ada@example.com"
        })
        assert.equal(dbState.users[0].password_hash.startsWith("$2"), true)
    })
})

test("register rejects weak passwords", async () => {
    await withServer(async baseUrl => {
        const response = await request(baseUrl, "/auth/register", {
            method: "POST",
            body: JSON.stringify({
                username: "Ada",
                email: "ada@example.com",
                password: "password"
            })
        })

        assert.equal(response.status, 400)
        assert.equal(response.body.error, "Password must contain uppercase, lowercase, number and special character")
    })
})

test("login returns a token for valid credentials", async () => {
    dbState.users.push({
        id: 7,
        username: "Ada",
        email: "ada@example.com",
        password_hash: await bcrypt.hash("StrongPass1!", 10)
    })

    await withServer(async baseUrl => {
        const response = await request(baseUrl, "/auth/login", {
            method: "POST",
            body: JSON.stringify({
                email: "ADA@example.com",
                password: "StrongPass1!"
            })
        })

        assert.equal(response.status, 200)
        assert.equal(response.body.user.email, "ada@example.com")
        assert.equal(jwt.verify(response.body.token, process.env.JWT_SECRET).id, 7)
    })
})

test("project routes require authentication", async () => {
    await withServer(async baseUrl => {
        const response = await request(baseUrl, "/projects", {
            method: "GET"
        })

        assert.equal(response.status, 401)
        assert.equal(response.body.error, "Missing token")
    })
})

test("authenticated users can create and list only their projects", async () => {
    dbState.projects.push({
        id: 99,
        user_id: 2,
        name: "Other user project",
        language: "python",
        source_code: "print('hidden')"
    })

    await withServer(async baseUrl => {
        const createResponse = await request(baseUrl, "/projects", {
            method: "POST",
            headers: authHeader({ id: 1, email: "ada@example.com" }),
            body: JSON.stringify({
                name: "  Sorting kata  ",
                language: "javascript",
                code: "console.log('ok')"
            })
        })

        assert.equal(createResponse.status, 201)
        assert.equal(createResponse.body.name, "Sorting kata")

        const listResponse = await request(baseUrl, "/projects", {
            method: "GET",
            headers: authHeader({ id: 1, email: "ada@example.com" })
        })

        assert.equal(listResponse.status, 200)
        assert.equal(listResponse.body.length, 1)
        assert.equal(listResponse.body[0].user_id, 1)
    })
})

test("users cannot read another user's project", async () => {
    dbState.projects.push({
        id: 10,
        user_id: 2,
        name: "Private",
        language: "python",
        source_code: "print('secret')"
    })

    await withServer(async baseUrl => {
        const response = await request(baseUrl, "/projects/10", {
            method: "GET",
            headers: authHeader({ id: 1, email: "ada@example.com" })
        })

        assert.equal(response.status, 404)
        assert.equal(response.body.error, "Project not found")
    })
})

test("run endpoint validates language and queues supported submissions", async () => {
    await withServer(async baseUrl => {
        const invalidResponse = await request(baseUrl, "/run", {
            method: "POST",
            body: JSON.stringify({
                language: "ruby",
                code: "puts 'nope'"
            })
        })

        assert.equal(invalidResponse.status, 400)
        assert.equal(invalidResponse.body.error, "Unsupported language")

        const queuedResponse = await request(baseUrl, "/run", {
            method: "POST",
            body: JSON.stringify({
                language: "python",
                code: "print('ok')",
                stdin: "input"
            })
        })

        assert.equal(queuedResponse.status, 202)
        assert.equal(queuedResponse.body.jobId, "1")
        assert.deepEqual(queueState.addedJobs[0].payload, {
            language: "python",
            code: "print('ok')",
            stdin: "input"
        })
    })
})

test("job lookup returns completed, running, and missing states", async () => {
    redisState.values.set("job:done", JSON.stringify({
        status: "completed",
        stdout: "ok"
    }))
    queueState.jobs.set("running", { id: "running" })

    await withServer(async baseUrl => {
        const doneResponse = await request(baseUrl, "/jobs/done")
        assert.equal(doneResponse.status, 200)
        assert.deepEqual(doneResponse.body, {
            status: "completed",
            stdout: "ok"
        })

        const runningResponse = await request(baseUrl, "/jobs/running")
        assert.equal(runningResponse.status, 200)
        assert.deepEqual(runningResponse.body, { status: "running" })

        const missingResponse = await request(baseUrl, "/jobs/missing")
        assert.equal(missingResponse.status, 404)
        assert.equal(missingResponse.body.error, "Job not found")
    })
})
