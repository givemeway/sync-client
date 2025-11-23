import { prisma } from "./Config/prismaDBConfig.js"

await prisma.fileQueue.deleteMany({})
await prisma.directoryQueue.deleteMany({})
await prisma.file.deleteMany({})
await prisma.directory.deleteMany({})

