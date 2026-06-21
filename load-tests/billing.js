import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";
const JWT_TOKEN = __ENV.JWT_TOKEN || "";

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "60s", target: 50 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  // GET /health
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    "health status 200": (r) => r.status === 200,
  });

  // POST /api/billing/invoice
  const payload = JSON.stringify({
    customerId: `cust-${__VU}-${__ITER}`,
    items: [
      { description: "Service Fee", quantity: 1, unitPrice: 500 },
    ],
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JWT_TOKEN}`,
    },
  };

  const invoiceRes = http.post(`${BASE_URL}/api/billing/invoice`, payload, params);
  check(invoiceRes, {
    "invoice status 200 or 201": (r) => r.status === 200 || r.status === 201,
    "invoice response has id": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.id !== undefined || body.invoiceId !== undefined;
      } catch (_) {
        return false;
      }
    },
  });

  sleep(1);
}
