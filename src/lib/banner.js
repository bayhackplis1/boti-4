import chalk from 'chalk';
import { BOT_CONFIG } from './config.js';

export function printBanner() {
    console.clear();
    console.log(chalk.cyanBright(`
  ╔══════════════════════════════════════════╗
  ║                                          ║
  ║   ██████╗  ██████╗ ████████╗            ║
  ║   ██╔══██╗██╔═══██╗╚══██╔══╝            ║
  ║   ██████╔╝██║   ██║   ██║               ║
  ║   ██╔══██╗██║   ██║   ██║               ║
  ║   ██████╔╝╚██████╔╝   ██║               ║
  ║   ╚═════╝  ╚═════╝    ╚═╝               ║
  ║                                          ║
  ║   WhatsApp Bot Base — Multidevice        ║
  ╚══════════════════════════════════════════╝`));
    console.log(chalk.gray(`
  Nombre  : ${chalk.white(BOT_CONFIG.name)}
  Versión : ${chalk.white(BOT_CONFIG.version)}
  Prefijo : ${chalk.white(BOT_CONFIG.prefix)}
`));
}
