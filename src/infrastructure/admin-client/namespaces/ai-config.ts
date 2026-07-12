/**
 * AI Config namespace — fetches AI settings from rezeis internal API.
 */
import type { AdminTransport } from '../transport.js';

export interface AiConfigSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  modelsEndpoint: string;
}

export interface AiInstruction {
  id: string;
  title: string;
  slug: string;
  content: string;
  category: string;
  orderIndex: number;
  isActive: boolean;
}

export class AiConfigNamespace {
  private readonly transport: AdminTransport;

  constructor(transport: AdminTransport) {
    this.transport = transport;
  }

  async getSettings(): Promise<AiConfigSettings> {
    return this.transport.request('GET', '/api/internal/ai-config/settings');
  }

  async getInstructions(): Promise<AiInstruction[]> {
    return this.transport.request('GET', '/api/internal/ai-config/instructions');
  }
}
