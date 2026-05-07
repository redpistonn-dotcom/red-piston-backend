export const errorHandler = (err, req, res, next) => {
  console.error(err.stack);
  const status = err.status || 500;
  const message = err.message || 'Internal server error';
  res.status(status).json({
    success: false,
    error: {
      code: err.code || `HTTP_${status}`,
      message,
    },
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
