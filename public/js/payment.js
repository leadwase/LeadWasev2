import { API } from './firebase-config.js';
import { authHeader } from './auth.js';

export async function createOrder(data) {
  const h = await authHeader();
  const r = await fetch(`${API}/orders/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...h },
    body: JSON.stringify(data),
  });
  return r.json();
}

export async function subscribePlan(plan) {
  const h = await authHeader();
  const r = await fetch(`${API}/subscriptions/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...h },
    body: JSON.stringify({ plan }),
  });
  return r.json();
}