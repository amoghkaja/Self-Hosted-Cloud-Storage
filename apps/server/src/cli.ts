import path from 'node:path';
import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { DisplayName, Email, Password } from '@familycloud/shared/all';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config';
import { createContext, ensureSetupToken } from './context';
import { users } from './db/schema';
import { reconcileUsage } from './jobs/maintenance';
import { MemoryQueue } from './jobs/queue';
import { setupTunnel } from './lib/cloudflare';
import { randomToken } from './lib/crypto';
import { hashPassword } from './lib/passwords';
import { exportFiles } from './modules/admin/export';
import { createUserWithRoot, dropRecoveryCodes } from './modules/auth/service';

const HELP = `Family Cloud admin CLI

Usage: cli <command> [options]

Commands:
  setup-token                    Print the first-run setup token (only before an admin exists)
  create-admin --email E --name N
                                 Create an admin account (prompts for a password)
  reset-password --email E       Set a new random password and print it once
  reset-totp --email E           Turn off two-factor for a user who lost their phone
  reconcile                      Recalculate every user's storage usage
  export --out DIR [--email E]   Rebuild normal folders from the blob store (disaster recovery).
                                 Hard-links when on the same disk, copies otherwise.
  migrate                        Apply database migrations and exit
  cloudflare-tunnel --hostname H Create (or reuse) a Cloudflare Tunnel to this app for address H,
                                 with its DNS record, and print the tunnel token. Reads a
                                 Cloudflare API token from CLOUDFLARE_API_TOKEN.
`;

/**
 * The new admin's password: FC_PASSWORD, or typed at a prompt that doesn't echo it (it would
 * otherwise stay in the terminal scrollback). Not trimmed: spaces are valid in passwords and the
 * web sign-in keeps them.
 */
async function newPassword(): Promise<string> {
  if (process.env.FC_PASSWORD) return Password.parse(process.env.FC_PASSWORD);
  const tty = stdin.isTTY === true;
  const muted = new Writable({ write: (_chunk, _enc, done) => done() });
  const rl = createInterface({ input: stdin, output: muted, terminal: tty });
  rl.on('SIGINT', () => process.exit(130)); // raw mode swallows Ctrl+C otherwise
  const ask = async (question: string) => {
    stdout.write(question);
    const answer = await rl.question('');
    stdout.write('\n');
    return answer;
  };
  try {
    const password = Password.parse(await ask('Password (10+ chars): '));
    // Typing is invisible, so ask twice on a terminal to catch typos.
    if (tty && (await ask('Repeat password: ')) !== password) {
      throw new Error('Passwords do not match');
    }
    return password;
  } finally {
    rl.close();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      hostname: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (!command || command === 'help' || command === '--help') {
    stdout.write(HELP);
    return;
  }

  // Needs no database: the installer runs it before anything is set up.
  if (command === 'cloudflare-tunnel') {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!apiToken || !values.hostname) {
      throw new Error(
        'Usage: CLOUDFLARE_API_TOKEN=... cli cloudflare-tunnel --hostname cloud.example.com',
      );
    }
    const { token } = await setupTunnel({
      apiToken,
      hostname: values.hostname,
      log: (line) => stderr.write(`  ${line}\n`),
    });
    stdout.write(`${token}\n`);
    return;
  }

  const config = loadConfig();
  const ctx = await createContext(config, { role: 'cli', jobs: new MemoryQueue() });
  try {
    switch (command) {
      case 'migrate':
        stdout.write('Migrations applied.\n');
        break;

      case 'setup-token': {
        const token = await ensureSetupToken(ctx);
        stdout.write(token ? `${token}\n` : 'Setup is complete (an account already exists).\n');
        break;
      }

      case 'create-admin': {
        const email = Email.parse(values.email);
        const name = DisplayName.parse(values.name ?? email.split('@')[0]);
        const passwordHash = await hashPassword(await newPassword());
        await ctx.db.transaction((tx) =>
          createUserWithRoot(tx, {
            email,
            displayName: name,
            passwordHash,
            role: 'admin',
            quotaBytes: null,
          }),
        );
        await ctx.settings.setRaw('setupToken', null);
        stdout.write(`Created admin ${email}\n`);
        break;
      }

      case 'reset-password': {
        const email = Email.parse(values.email);
        const password = randomToken(12);
        const rows = await ctx.db
          .update(users)
          .set({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null })
          .where(eq(users.email, email))
          .returning({ id: users.id });
        if (!rows[0]) throw new Error(`No user ${email}`);
        await ctx.sessions.revokeAll(ctx.db, rows[0].id);
        stdout.write(
          `New password for ${email}: ${password}\nAsk them to change it in Settings.\n`,
        );
        break;
      }

      case 'reset-totp': {
        const email = Email.parse(values.email);
        const rows = await ctx.db
          .update(users)
          .set({ totpEnabled: false, totpSecretEnc: null, totpLastStep: null })
          .where(eq(users.email, email))
          .returning({ id: users.id });
        if (!rows[0]) throw new Error(`No user ${email}`);
        await dropRecoveryCodes(ctx.db, rows[0].id);
        stdout.write(`Two-factor turned off for ${email}.\n`);
        break;
      }

      case 'reconcile': {
        const drift = await reconcileUsage(ctx);
        stdout.write(
          drift.length ? `Corrected ${drift.length} user(s).\n` : 'Usage already correct.\n',
        );
        break;
      }

      case 'export': {
        if (!values.out) throw new Error('--out is required');
        const out = path.resolve(values.out);
        const { files, failed } = await exportFiles(ctx, out, {
          email: values.email ? Email.parse(values.email) : undefined,
        });
        stdout.write(`Exported ${files} files to ${out}\n`);
        if (failed.length) {
          for (const f of failed.slice(0, 50)) stderr.write(`  failed: ${f.path} (${f.error})\n`);
          if (failed.length > 50) stderr.write(`  …and ${failed.length - 50} more\n`);
          stderr.write(`${failed.length} file(s) could not be exported.\n`);
          process.exitCode = 1;
        }
        break;
      }

      default:
        stdout.write(`Unknown command: ${command}\n\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
