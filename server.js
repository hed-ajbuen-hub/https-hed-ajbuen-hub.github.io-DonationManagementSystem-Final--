const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const express = require("express");
const Database = require("better-sqlite3");
const { Pool } = require("pg");

const app = express();
const allowedFrontendOrigins = new Set((process.env.FRONTEND_ORIGINS || "")
    .split(",").map((origin) => origin.trim()).filter(Boolean));
const port = Number(process.env.PORT) || 3000;
const databaseUrl = process.env.DATABASE_URL;
const sessionCookie = "donation_session";
const resetAttempts = new Map();
const scrypt = promisify(crypto.scrypt);
const sqlitePath = path.join(process.env.DATA_DIR || __dirname, ".donations.sqlite");

if (!databaseUrl && process.env.DATA_DIR) {
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
}

const sqliteDatabase = databaseUrl ? null : new Database(sqlitePath);
const postgresPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
if (postgresPool) {
    postgresPool.on("error", (error) => console.error("Database connection error:", error.message));
}

function toPostgresSql(sql) {
    let parameterIndex = 0;
    const ignoreConflict = /^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
    let converted = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO")
        .replace(/\?/g, () => `$${++parameterIndex}`);
    if (ignoreConflict) converted += " ON CONFLICT DO NOTHING";
    return converted;
}

const database = {
    async exec(sql) {
        if (postgresPool) {
            await postgresPool.query(sql);
        } else {
            sqliteDatabase.exec(sql);
        }
    },
    prepare(sql) {
        return {
            async get(...params) {
                if (postgresPool) {
                    const result = await postgresPool.query(toPostgresSql(sql), params);
                    return result.rows[0];
                }
                return sqliteDatabase.prepare(sql).get(...params);
            },
            async all(...params) {
                if (postgresPool) {
                    const result = await postgresPool.query(toPostgresSql(sql), params);
                    return result.rows;
                }
                return sqliteDatabase.prepare(sql).all(...params);
            },
            async run(...params) {
                if (postgresPool) {
                    let postgresSql = toPostgresSql(sql);
                    if (/^\s*INSERT\b/i.test(postgresSql) && !/\bON\s+CONFLICT\b/i.test(postgresSql)) {
                        postgresSql += " RETURNING id";
                    }
                    const result = await postgresPool.query(postgresSql, params);
                    return { lastInsertRowid: result.rows[0]?.id };
                }
                return sqliteDatabase.prepare(sql).run(...params);
            }
        };
    }
};

const sqliteSchema = `
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS donors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        target_amount REAL NOT NULL CHECK (target_amount >= 0),
        status TEXT NOT NULL CHECK (status IN ('Active', 'Pending', 'Completed')),
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS beneficiaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        classification TEXT NOT NULL DEFAULT '',
        eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('Eligible', 'Pending', 'Ineligible')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        donation_number TEXT NOT NULL UNIQUE,
        donor_id INTEGER NOT NULL REFERENCES donors(id),
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        amount REAL NOT NULL CHECK (amount > 0),
        status TEXT NOT NULL CHECK (status IN ('Pending', 'Verified', 'Completed')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`;

const postgresSchema = `
    CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS donors (
        id BIGSERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS campaigns (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        target_amount DOUBLE PRECISION NOT NULL CHECK (target_amount >= 0),
        status TEXT NOT NULL CHECK (status IN ('Active', 'Pending', 'Completed')),
        description TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS beneficiaries (
        id BIGSERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        classification TEXT NOT NULL DEFAULT '',
        eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('Eligible', 'Pending', 'Ineligible')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS donations (
        id BIGSERIAL PRIMARY KEY,
        donation_number TEXT NOT NULL UNIQUE,
        donor_id BIGINT NOT NULL REFERENCES donors(id),
        campaign_id BIGINT NOT NULL REFERENCES campaigns(id),
        amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
        status TEXT NOT NULL CHECK (status IN ('Pending', 'Verified', 'Completed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`;

function loadUserRecoveryCode() {
    if (process.env.USER_RESET_CODE !== undefined) return process.env.USER_RESET_CODE;
    const recoveryKeyPath = path.join(__dirname, ".user-recovery-key");
    try {
        return fs.readFileSync(recoveryKeyPath, "utf8").trim();
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error("Could not read the user recovery key file.");
            return "";
        }
    }
    const recoveryCode = crypto.randomBytes(32).toString("hex");
    try {
        fs.writeFileSync(recoveryKeyPath, recoveryCode, { encoding: "utf8", flag: "wx", mode: 0o600 });
        console.log("Generated a user recovery key in .user-recovery-key; keep that file private.");
        return recoveryCode;
    } catch (error) {
        if (error.code === "EEXIST") return fs.readFileSync(recoveryKeyPath, "utf8").trim();
        console.error("Could not save the generated user recovery key.");
        return "";
    }
}

const userRecoveryCode = loadUserRecoveryCode();

async function createAccount(username, password, role) {
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
    await database.prepare(
        "INSERT OR IGNORE INTO users (username, password_salt, password_hash, role) VALUES (?, ?, ?, ?)"
    ).run(username, salt, passwordHash, role);
}

async function initializeDatabase() {
    if (sqliteDatabase) sqliteDatabase.pragma("foreign_keys = ON");
    await database.exec(databaseUrl ? postgresSchema : sqliteSchema);
    await createAccount("admin", process.env.ADMIN_PASSWORD || "Admin123!", "admin");
    const userUsername = process.env.USER_USERNAME || "donation_user";
    const userPassword = process.env.USER_PASSWORD || "GiveWithCare2026!";
    const existingUser = await database.prepare("SELECT id, username FROM users WHERE role = 'user'").get();
    if (!existingUser) {
        await createAccount(userUsername, userPassword, "user");
    } else if (existingUser.username === "user") {
        const salt = crypto.randomBytes(16).toString("hex");
        const passwordHash = crypto.scryptSync(userPassword, salt, 64).toString("hex");
        await database.prepare("UPDATE users SET username = ?, password_salt = ?, password_hash = ? WHERE id = ?")
            .run(userUsername, salt, passwordHash, existingUser.id);
        await database.prepare("DELETE FROM sessions WHERE user_id = ?").run(existingUser.id);
    }

    if (Number((await database.prepare("SELECT COUNT(*) AS count FROM donors").get()).count) === 0) {
        await database.prepare("INSERT INTO donors (full_name, email, phone, address) VALUES (?, ?, ?, ?)")
            .run("Maria Santos", "maria.santos@email.com", "09181234567", "Manila, Philippines");
        await database.prepare("INSERT INTO donors (full_name, email, phone, address) VALUES (?, ?, ?, ?)")
            .run("John Smith", "john.smith@email.com", "09229876543", "Quezon City");
    }
    if (Number((await database.prepare("SELECT COUNT(*) AS count FROM campaigns").get()).count) === 0) {
        await database.prepare("INSERT INTO campaigns (title, target_amount, status, description) VALUES (?, ?, ?, ?)")
            .run("Typhoon Relief Fund", 50000, "Active", "Emergency relief for families affected by the typhoon.");
        await database.prepare("INSERT INTO campaigns (title, target_amount, status, description) VALUES (?, ?, ?, ?)")
            .run("School Supplies Drive", 20000, "Completed", "School supplies for local students.");
    }
    if (Number((await database.prepare("SELECT COUNT(*) AS count FROM beneficiaries").get()).count) === 0) {
        await database.prepare("INSERT INTO beneficiaries (full_name, classification, eligibility_status) VALUES (?, ?, ?)")
            .run("Ana Cruz", "Calamity Victim", "Eligible");
        await database.prepare("INSERT INTO beneficiaries (full_name, classification, eligibility_status) VALUES (?, ?, ?)")
            .run("Pedro Ramos", "Senior Citizen", "Pending");
    }
    if (Number((await database.prepare("SELECT COUNT(*) AS count FROM donations").get()).count) === 0) {
        await database.prepare("INSERT INTO donations (donation_number, donor_id, campaign_id, amount, status) VALUES (?, ?, ?, ?, ?)")
            .run("DON-2026-001", 1, 1, 5000, "Verified");
        await database.prepare("INSERT INTO donations (donation_number, donor_id, campaign_id, amount, status) VALUES (?, ?, ?, ?, ?)")
            .run("DON-2026-002", 2, 2, 2500, "Pending");
    }
}

const asyncRoute = (handler) => (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
};

function getCookie(request, name) {
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

async function readSession(request) {
    const token = getCookie(request, sessionCookie);
    if (!token) return null;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    return database.prepare(`
        SELECT users.id, users.username, users.role
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP
    `).get(tokenHash);
}

app.use((request, response, next) => {
    const origin = request.get("Origin");
    if (origin && allowedFrontendOrigins.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Credentials", "true");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
        return response.sendStatus(origin && allowedFrontendOrigins.has(origin) ? 204 : 403);
    }
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((request, response, next) => {
    readSession(request).then((user) => {
        request.user = user || null;
        next();
    }).catch(next);
});

app.get("/health", (request, response) => response.json({ status: "ok" }));

app.post("/api/auth/login", asyncRoute(async (request, response) => {
    const username = String(request.body.username || "").trim();
    const password = String(request.body.password || "");
    const account = await database.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!account) return response.status(401).json({ error: "Invalid username or password." });

    const passwordHash = await scrypt(password, account.password_salt, 64);
    if (!crypto.timingSafeEqual(passwordHash, Buffer.from(account.password_hash, "hex"))) {
        return response.status(401).json({ error: "Invalid username or password." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    await database.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
    await database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(tokenHash, account.id, expiresAt);
    const useCrossSiteCookie = process.env.NODE_ENV === "production" || allowedFrontendOrigins.has(request.get("Origin"));
    const sameSite = useCrossSiteCookie ? "None" : "Lax";
    response.setHeader("Set-Cookie", `${sessionCookie}=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=28800${useCrossSiteCookie ? "; Secure" : ""}`);
    response.json({ username: account.username, role: account.role });
}));

app.post("/api/auth/reset-user-password", asyncRoute(async (request, response) => {
    const recoveryCode = String(request.body.recoveryCode || "");
    const newPassword = String(request.body.newPassword || "");
    const clientKey = request.ip;
    const now = Date.now();
    const attempt = resetAttempts.get(clientKey);
    if (attempt && attempt.resetAt <= now) resetAttempts.delete(clientKey);
    else if (attempt && attempt.count >= 5) {
        return response.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    }
    if (userRecoveryCode.length < 16) {
        return response.status(503).json({ error: "Password recovery is not configured on the server." });
    }
    if (newPassword.length < 10 || newPassword.length > 128) {
        return response.status(400).json({ error: "Use a new password between 10 and 128 characters." });
    }

    const expectedHash = crypto.createHash("sha256").update(userRecoveryCode).digest();
    const suppliedHash = crypto.createHash("sha256").update(recoveryCode).digest();
    if (!crypto.timingSafeEqual(expectedHash, suppliedHash)) {
        const current = resetAttempts.get(clientKey);
        resetAttempts.set(clientKey, {
            count: current && current.resetAt > now ? current.count + 1 : 1,
            resetAt: current && current.resetAt > now ? current.resetAt : now + 15 * 60 * 1000
        });
        return response.status(400).json({ error: "The recovery code is incorrect." });
    }

    const user = await database.prepare("SELECT id FROM users WHERE role = 'user'").get();
    if (!user) return response.status(404).json({ error: "The regular user account is unavailable." });
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(newPassword, salt, 64).toString("hex");
    await database.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?")
        .run(salt, passwordHash, user.id);
    await database.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    resetAttempts.delete(clientKey);
    response.json({ success: true });
}));

app.get("/api/auth/me", (request, response) => {
    if (!request.user) return response.status(401).json({ error: "Please sign in." });
    response.json({ username: request.user.username, role: request.user.role });
});

app.post("/api/auth/logout", asyncRoute(async (request, response) => {
    const token = getCookie(request, sessionCookie);
    if (token) {
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        await database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    }
    response.setHeader("Set-Cookie", `${sessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    response.json({ success: true });
}));

function requireAuth(request, response, next) {
    if (!request.user) return response.status(401).json({ error: "Please sign in." });
    next();
}

function requireAdmin(request, response, next) {
    if (request.user?.role !== "admin") {
        return response.status(403).json({ error: "Administrator access is required for this action." });
    }
    next();
}

app.use("/api", requireAuth);

app.get("/api/donors", asyncRoute(async (request, response) => {
    response.json(await database.prepare("SELECT * FROM donors ORDER BY id").all());
}));

app.post("/api/donors", asyncRoute(async (request, response) => {
    const { fullName, email, phone = "", address = "" } = request.body;
    if (!fullName?.trim() || !email?.trim()) {
        return response.status(400).json({ error: "Full name and email are required." });
    }
    const result = await database.prepare(
        "INSERT INTO donors (full_name, email, phone, address) VALUES (?, ?, ?, ?)"
    ).run(fullName.trim(), email.trim(), phone.trim(), address.trim());
    response.status(201).json(await database.prepare("SELECT * FROM donors WHERE id = ?").get(result.lastInsertRowid));
}));

app.get("/api/campaigns", asyncRoute(async (request, response) => {
    response.json(await database.prepare(`
        SELECT campaigns.*,
            COALESCE(SUM(CASE WHEN donations.status IN ('Verified', 'Completed') THEN donations.amount ELSE 0 END), 0) AS current_amount
        FROM campaigns
        LEFT JOIN donations ON donations.campaign_id = campaigns.id
        GROUP BY campaigns.id
        ORDER BY campaigns.id
    `).all());
}));

app.post("/api/campaigns", requireAdmin, asyncRoute(async (request, response) => {
    const { title, targetAmount, status = "Active", description = "" } = request.body;
    const target = Number(targetAmount);
    if (!title?.trim() || !Number.isFinite(target) || target < 0) {
        return response.status(400).json({ error: "Enter a campaign title and a valid target amount." });
    }
    if (!["Active", "Pending", "Completed"].includes(status)) {
        return response.status(400).json({ error: "Choose a valid campaign status." });
    }
    const result = await database.prepare(
        "INSERT INTO campaigns (title, target_amount, status, description) VALUES (?, ?, ?, ?)"
    ).run(title.trim(), target, status, description.trim());
    response.status(201).json(await database.prepare("SELECT * FROM campaigns WHERE id = ?").get(result.lastInsertRowid));
}));

app.get("/api/beneficiaries", asyncRoute(async (request, response) => {
    response.json(await database.prepare("SELECT * FROM beneficiaries ORDER BY id").all());
}));

app.post("/api/beneficiaries", requireAdmin, asyncRoute(async (request, response) => {
    const { fullName, classification = "", eligibilityStatus = "Eligible" } = request.body;
    if (!fullName?.trim()) return response.status(400).json({ error: "Full name is required." });
    if (!["Eligible", "Pending", "Ineligible"].includes(eligibilityStatus)) {
        return response.status(400).json({ error: "Choose a valid eligibility status." });
    }
    const result = await database.prepare(
        "INSERT INTO beneficiaries (full_name, classification, eligibility_status) VALUES (?, ?, ?)"
    ).run(fullName.trim(), classification.trim(), eligibilityStatus);
    response.status(201).json(await database.prepare("SELECT * FROM beneficiaries WHERE id = ?").get(result.lastInsertRowid));
}));

app.get("/api/donations", asyncRoute(async (request, response) => {
    response.json(await database.prepare(`
        SELECT donations.*, donors.full_name AS donor_name, campaigns.title AS campaign_title
        FROM donations
        JOIN donors ON donors.id = donations.donor_id
        JOIN campaigns ON campaigns.id = donations.campaign_id
        ORDER BY donations.id
    `).all());
}));

app.post("/api/donations", asyncRoute(async (request, response) => {
    const { donationNumber, donorId, campaignId, amount } = request.body;
    const status = request.user.role === "admin" ? request.body.status || "Pending" : "Pending";
    const numericAmount = Number(amount);
    if (!donationNumber?.trim() || !Number.isInteger(Number(donorId)) || !Number.isInteger(Number(campaignId)) || !Number.isFinite(numericAmount) || numericAmount <= 0) {
        return response.status(400).json({ error: "Enter a donation number, donor, campaign, and positive amount." });
    }
    if (!["Pending", "Verified", "Completed"].includes(status)) {
        return response.status(400).json({ error: "Choose a valid donation status." });
    }
    const result = await database.prepare(
        "INSERT INTO donations (donation_number, donor_id, campaign_id, amount, status) VALUES (?, ?, ?, ?, ?)"
    ).run(donationNumber.trim(), Number(donorId), Number(campaignId), numericAmount, status);
    response.status(201).json(await database.prepare("SELECT * FROM donations WHERE id = ?").get(result.lastInsertRowid));
}));

app.use("/api", (error, request, response, next) => {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") {
        return response.status(409).json({ error: "That email or donation number is already in use." });
    }
    if (error.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || error.code === "23503") {
        return response.status(400).json({ error: "Select an existing donor and campaign." });
    }
    console.error(error);
    response.status(500).json({ error: "The request could not be saved." });
});

app.get("/", (request, response) => response.redirect(request.user ? "/index.html" : "/login.html"));

app.use((request, response, next) => {
    if (["/login.html", "/login.js", "/forgot-password.html", "/forgot-password.js", "/style.css"].includes(request.path)) {
        return next();
    }
    if (!request.user) return response.redirect("/login.html");
    next();
});

app.use(express.static(__dirname, { dotfiles: "deny" }));

initializeDatabase().then(() => {
    app.listen(port, () => {
        console.log(`Donation Management System is running at http://localhost:${port}`);
    });
}).catch((error) => {
    console.error("Could not initialize the database:", error);
    process.exit(1);
});