import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { sql, queryOne } from '../db/client';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_ACCESS_SECRET!, {
    expiresIn: '15m',
  });
}

function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_REFRESH_SECRET!, {
    expiresIn: '30d',
  });
}

async function storeRefreshToken(userId: string, rawToken: string): Promise<void> {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await sql`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}, ${hash}, ${expiresAt})
  `;
}

async function ensureProfile(userId: string): Promise<void> {
  await sql`
    INSERT INTO profiles (user_id)
    VALUES (${userId})
    ON CONFLICT (user_id) DO NOTHING
  `;
}

// ── POST /auth/register ───────────────────────────────────────────────────────

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(100),
});

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { email, password, displayName } = parsed.data;

  try {
    const existing = await queryOne`
      SELECT id FROM users WHERE email = ${email}
    `;
    if (existing) {
      res.status(409).json({ error: 'Email already in use' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await queryOne<{ id: string }>`
      INSERT INTO users (email, display_name, password_hash)
      VALUES (${email}, ${displayName}, ${passwordHash})
      RETURNING id
    `;

    await ensureProfile(user!.id);

    const accessToken = signAccessToken(user!.id);
    const refreshToken = signRefreshToken(user!.id);
    await storeRefreshToken(user!.id, refreshToken);

    res.status(201).json({
      accessToken,
      refreshToken,
      user: { id: user!.id, email, displayName },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────────

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid credentials format' });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const user = await queryOne<{
      id: string;
      email: string;
      display_name: string;
      photo_url: string | null;
      password_hash: string | null;
    }>`
      SELECT id, email, display_name, photo_url, password_hash
      FROM users WHERE email = ${email}
    `;

    if (!user || !user.password_hash) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    await ensureProfile(user.id);

    const accessToken = signAccessToken(user.id);
    const refreshToken = signRefreshToken(user.id);
    await storeRefreshToken(user.id, refreshToken);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        photoUrl: user.photo_url,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────

router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken required' });
    return;
  }

  try {
    const payload = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET!
    ) as { sub: string };

    const hash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    const stored = await queryOne<{ id: string; expires_at: string }>`
      SELECT id, expires_at FROM refresh_tokens
      WHERE token_hash = ${hash} AND user_id = ${payload.sub}
    `;

    if (!stored || new Date(stored.expires_at) < new Date()) {
      res.status(401).json({ error: 'Refresh token invalid or expired' });
      return;
    }

    // Rotate: delete old, issue new
    await sql`DELETE FROM refresh_tokens WHERE id = ${stored.id}`;

    const newAccessToken = signAccessToken(payload.sub);
    const newRefreshToken = signRefreshToken(payload.sub);
    await storeRefreshToken(payload.sub, newRefreshToken);

    res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────

router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (refreshToken) {
    const hash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');
    await sql`DELETE FROM refresh_tokens WHERE token_hash = ${hash}`.catch(
      () => {}
    );
  }
  res.json({ success: true });
});

export default router;
