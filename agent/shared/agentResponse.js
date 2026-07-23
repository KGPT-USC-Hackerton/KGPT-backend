function agentError(res, statusCode, errorCode, message, extra = {}) {
  return res.status(statusCode).json({ success: false, error_code: errorCode, message, ...extra });
}

module.exports = { agentError };
