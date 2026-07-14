import { AppConfig, loadConfig } from './config.js';
import { SessionManager } from './sessions/manager.js';
import { StaticAdapter } from './static/adapter.js';

export class WxmpApp {
  readonly config: AppConfig;
  readonly sessions: SessionManager;
  readonly staticAdapter: StaticAdapter;

  constructor(config = loadConfig()) {
    this.config = config;
    this.sessions = new SessionManager(config);
    this.staticAdapter = new StaticAdapter(config);
  }

  async shutdown(): Promise<void> {
    await this.sessions.shutdown();
  }
}
