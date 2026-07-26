const MAX_LOGS = 500;
const logs = [];
let endpointHealth = {
  total: 0,
  success: 0,
  errors4xx: 0,
  errors5xx: 0,
  avgLatency: 0
};

/**
 * Middleware to intercept and log all incoming network requests
 */
function networkLogger(req, res, next) {
  // Ignore requests to the logs endpoint itself to prevent infinite feedback loop
  if (req.path === '/api/admin/network-logs') {
    return next();
  }

  const start = process.hrtime();
  
  // Capture response finish
  res.on('finish', () => {
    const diff = process.hrtime(start);
    const latency = Math.round((diff[0] * 1e9 + diff[1]) / 1e6); // in ms
    
    const statusCode = res.statusCode;
    const is4xx = statusCode >= 400 && statusCode < 500;
    const is5xx = statusCode >= 500;
    
    // Update stats
    endpointHealth.total++;
    if (is4xx) endpointHealth.errors4xx++;
    else if (is5xx) endpointHealth.errors5xx++;
    else endpointHealth.success++;
    
    // Running average for latency
    endpointHealth.avgLatency = Math.round((endpointHealth.avgLatency * (endpointHealth.total - 1) + latency) / endpointHealth.total);

    // Extract client IP (handling proxies)
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';

    const logEntry = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: statusCode,
      latency,
      ip: ip.split(',')[0].trim()
    };

    logs.unshift(logEntry); // Add to beginning
    
    if (logs.length > MAX_LOGS) {
      logs.pop(); // Remove oldest
    }
  });

  next();
}

/**
 * Get current logs and stats
 */
function getNetworkStats() {
  return {
    logs,
    health: endpointHealth
  };
}

export { networkLogger, getNetworkStats };
