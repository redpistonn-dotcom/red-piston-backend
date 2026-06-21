import { PrismaClient } from "@prisma/client"

const prismaReader = new PrismaClient({
  datasourceUrl: process.env.READ_REPLICA_URL || process.env.DATABASE_URL,
})

export default prismaReader
