import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.zhiwu.learning',
  appName: '知悟',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
  },
  plugins: {
    // Enable native Android HTTP bridge so direct AI API calls (DeepSeek/Qwen/Gemini/OpenAI) bypass WebView CORS
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
