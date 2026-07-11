require("dotenv/config");
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
    const projects = await prisma.cloudProject.findMany();
    res.status(200).json(projects);
  } catch (error) {
    console.error("Error fetching projects:", error);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
