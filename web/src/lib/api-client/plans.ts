/**
 * Plans catalog namespace.
 */
import { apiClient } from "./transport.js";
import type { Plan } from "@/types/api";

export const getPlans = () => apiClient.get<Plan[]>("/plans").then((r) => r.data);
