require("dotenv/config");

// Prefer IPv4 when resolving hostnames. The multipass VM resolves Neon to
// IPv6 (AAAA) addresses but has no IPv6 route, so the Neon WebSocket driver
// would otherwise hang/ETIMEDOUT. This forces the IPv4 path (works on host too).
require("node:dns").setDefaultResultOrder("ipv4first");

const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const { PrismaNeon } = require("@prisma/adapter-neon");
const { neonConfig } = require("@neondatabase/serverless");
const ws = require("ws");

// The Neon serverless driver needs a WebSocket implementation in Node.
neonConfig.webSocketConstructor = ws;

const app = express();

app.use(cors());
app.use(express.json());

// Prisma 7 uses driver adapters. The Neon adapter handles Neon's pooler and
// wake-from-idle behavior, avoiding intermittent ETIMEDOUT errors.
const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Health check / welcome route.
app.get("/", (req, res) => {
  res.json({ message: "Local EC2 Backend is running.........!" });
});

// Create a new project.
app.post("/api/projects", async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const project = await prisma.cloudProject.create({
      data: { name, description },
    });
    res.status(201).json(project);
  } catch (error) {
    console.error("Error creating project:", error);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// Fetch all projects.
app.get("/api/projects", async (req, res) => {
  try {
    const projects = await prisma.cloudProject.findMany({
      orderBy: { id: "desc" },
    });
    res.status(200).json(projects);
  } catch (error) {
    console.error("Error fetching projects:", error);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// Shared helper: update a project's status (simulated instance state change).
async function setStatus(req, res, status) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid project id" });
  }
  try {
    const project = await prisma.cloudProject.update({
      where: { id },
      data: { status },
    });
    res.status(200).json(project);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Project not found" });
    }
    console.error(`Error updating project ${id} to ${status}:`, error);
    res.status(500).json({ error: "Failed to update project status" });
  }
}

// Stop an instance -> status STOPPED.
app.post("/api/projects/:id/stop", (req, res) => setStatus(req, res, "STOPPED"));

// Start an instance -> status RUNNING.
app.post("/api/projects/:id/start", (req, res) => setStatus(req, res, "RUNNING"));

// Terminate an instance -> delete the record.
app.delete("/api/projects/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid project id" });
  }
  try {
    await prisma.cloudProject.delete({ where: { id } });
    res.status(200).json({ id, deleted: true });
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Project not found" });
    }
    console.error(`Error deleting project ${id}:`, error);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT} (0.0.0.0 — accepting external traffic)`);
});
