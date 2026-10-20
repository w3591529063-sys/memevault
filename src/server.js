import process from 'node:process';
import { loadEnvFile } from 'node:process';
import { createApp } from './app.js';

try {
  loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const app = await createApp();
let address;
try {
  address = await app.listen();
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`[memevault] 端口 ${app.config.port} 已被占用，请设置 PORT 环境变量。`);
  } else {
    console.error('[memevault] 启动失败：', error);
  }
  process.exit(1);
}

console.log('');
console.log('  表情包仓库 MemeVault');
console.log(`  本机访问   http://localhost:${address.port}`);
console.log(`  数据目录   ${app.config.dataDir}`);
console.log(`  管理密钥   ${app.config.adminToken ? '已启用' : '未设置（设置 ADMIN_TOKEN 可管理全站）'}`);
console.log('');
console.log('  按 Ctrl+C 停止');
console.log('');

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[memevault] 收到 ${signal}，正在关闭…`);
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error('[memevault] 关闭时出错：', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
