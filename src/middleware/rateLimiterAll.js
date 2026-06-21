import rateLimit from "express-rate-limit"

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  skip: (req) => req.path === "/health",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please slow down and try again in a minute.",
      },
    })
  },
})

export const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please slow down and try again in a minute.",
      },
    })
  },
})
