import { Prisma, PrismaClient } from "../DB/prisma-client/index.js";
import { Prisma as PrismaQueue, PrismaClient as PrismaClientQueue} from "../DB/prisma-client-queue/index.js";
const prisma = new PrismaClient({ log: ["query", "info", "warn", "error"] });
const prisma_queue = new PrismaClientQueue({log:["query","info","warn","error"]});
await prisma_queue.$connect();
await prisma.$connect();
console.log("Connected to the local SQLLite database successfully.");
export { prisma, Prisma,PrismaQueue,prisma_queue };
