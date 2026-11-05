export interface BrowserProfileConfig {
  description?: string;
  browser: 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'arc' | 'firefox' | 'custom';
  binary?: string;
  electron?: boolean;
  targetFilter?: string;
  endpoints: string[] | Record<string, { target: string; binary?: string; targetFilter?: string }>;
  defaultEndpoint?: string;
  launchPolicy?: 'attach-only' | 'launch';
  userDataDir?: string;
  profileDirectory?: string;
  chrome?: {
    headless?: boolean;
    args?: string[];
  };
  secrets?: string;
  viewport?: { width: number; height: number };
  arc?: {
    profileId: string;
    profileName: string;
  };
  firefox?: {
    profileName: string;
    iniPath: string;
    isDefault: boolean;
  };
}

export interface Meta {
  browser?: Record<string, BrowserProfileConfig>;
  privateBrowser?: Record<string, BrowserProfileConfig>;
  deviceBrowser?: Record<string, BrowserProfileConfig>;
  deviceConfig?: Record<string, unknown>;
  [key: string]: unknown;
}
