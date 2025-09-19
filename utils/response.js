function success(data = {}) {
  return { code: 200, message: 'success', data };
}

function fail(code = 400, message = 'error', data = {}) {
  return { code, message, data };
}

module.exports = {
  success,
  fail,
};
