import { Router, Response, Request } from 'express';
import { z } from 'zod';
import { sql } from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── POST /sessions ────────────────────────────────────────────────────────────

const CreateSessionSchema = z.object({
  duration: z.number().int().min(1).max(86400),
  goal: z.string().min(1).max(200),
  allowedApps: z.array(z.string().max(50)).max(30),
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = CreateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { duration, goal, allowedApps } = parsed.data;

  try {
    const rows = await sql`
      INSERT INTO focus_sessions (user_id, duration, goal, allowed_apps)
      VALUES (${req.userId!}, ${duration}, ${goal}, ${allowedApps})
      RETURNING id, user_id, started_at, duration, goal, allowed_apps, completed
    `;
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /sessions/stats (must be before /:id) ─────────────────────────────────

router.get('/stats', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const daily = await sql`
      SELECT
        TO_CHAR(started_at AT TIME ZONE 'UTC', 'Dy') AS "dayLabel",
        DATE_TRUNC('day', started_at)                AS "dayDate",
        COALESCE(SUM(duration) / 60, 0)::int         AS minutes
      FROM focus_sessions
      WHERE user_id  = ${req.userId!}
        AND started_at >= NOW() - INTERVAL '7 days'
      GROUP BY "dayDate", "dayLabel"
      ORDER BY "dayDate" ASC
    `;

    const streakRows = await sql`
      WITH daily AS (
        SELECT DISTINCT DATE_TRUNC('day', started_at)::date AS d
        FROM focus_sessions
        WHERE user_id = ${req.userId!}
      ),
      gaps AS (
        SELECT d,
               d - ROW_NUMBER() OVER (ORDER BY d)::int AS grp
        FROM daily
      )
      SELECT COUNT(*)::int AS streak
      FROM gaps
      WHERE grp = (SELECT grp FROM gaps ORDER BY d DESC LIMIT 1)
    `;

    const totals = await sql`
      SELECT
        COALESCE(SUM(duration) / 60, 0)::int AS "weekMinutes",
        COUNT(*)::int                          AS "sessionCount"
      FROM focus_sessions
      WHERE user_id  = ${req.userId!}
        AND started_at >= NOW() - INTERVAL '7 days'
    `;

    res.json({
      daily,
      streak: streakRows[0]?.streak ?? 0,
      weekMinutes: totals[0]?.weekMinutes ?? 0,
      sessionCount: totals[0]?.sessionCount ?? 0,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /sessions ─────────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const daysParam = req.query['days'];
  const daysNum = Math.min(
    90,
    Math.max(1, parseInt(String(daysParam ?? '7'), 10) || 7)
  );

  try {
    const rows = await sql`
      SELECT id, started_at, duration, goal, allowed_apps, completed, ended_at
      FROM focus_sessions
      WHERE user_id = ${req.userId!}
        AND started_at >= NOW() - (${daysNum} || ' days')::INTERVAL
      ORDER BY started_at DESC
    `;
    res.json(rows);
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /sessions/:id ───────────────────────────────────────────────────────

const UpdateSessionSchema = z.object({
  completed: z.boolean().optional(),
  endedAt: z.string().datetime().optional(),
});

router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const parsed = UpdateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const rows = await sql`
      SELECT id FROM focus_sessions
      WHERE id = ${id} AND user_id = ${req.userId!}
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const { completed, endedAt } = parsed.data;
    const updated = await sql`
      UPDATE focus_sessions
      SET
        completed = COALESCE(${completed ?? null}, completed),
        ended_at  = COALESCE(${endedAt ?? null}::TIMESTAMPTZ, ended_at)
      WHERE id = ${id} AND user_id = ${req.userId!}
      RETURNING id, started_at, duration, goal, allowed_apps, completed, ended_at
    `;
    res.json(updated[0]);
  } catch (err) {
    console.error('Update session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /sessions/:id ──────────────────────────────────────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    await sql`
      DELETE FROM focus_sessions
      WHERE id = ${id} AND user_id = ${req.userId!}
    `;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
