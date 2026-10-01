import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// F-07 (W4.A): query logging is dev-only. Hosted deployments (Vercel) set
// NODE_ENV=production, so ['query'] logging is OFF there; local dev
// (next dev → NODE_ENV=development) and tests keep full query logging.
const queryLog: Array<'query'> = process.env.NODE_ENV === 'production' ? [] : ['query']

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: queryLog,
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
