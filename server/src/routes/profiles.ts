import { Router, Response } from 'express';
import { z } from 'zod';
import { sql, queryOne } from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── GET /profile ──────────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const profile = await queryOne<{
      user_id: string;
      daily_goal: number;
      preferred_apps: string[];
      schedule: unknown;
      settings: unknown;
      display_name: string;
      email: string;
      photo_url: string | null;
    }>`
      SELECT p.user_id, p.daily_goal, p.preferred_apps, p.schedule, p.settings,
             u.display_name, u.email, u.photo_url
      FROM profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ${req.userId!}
    `;

    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    // Normalise to camelCase for the mobile client
    res.json({
      userId: profile.user_id,
      dailyGoal: profile.daily_goal,
      preferredApps: profile.preferred_apps,
      schedule: profile.schedule,
      settings: profile.settings,
      displayName: profile.display_name,
      email: profile.email,
      photoUrl: profile.photo_url,
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /profile ────────────────────────────────────────────────────────────

const ScheduleEntrySchema = z.object({
  day: z.string().max(20),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
});

const UpdateProfileSchema = z.object({
  dailyGoal: z.number().int().min(1).max(1440).optional(),
  preferredApps: z.array(z.string().max(50)).max(30).optional(),
  schedule: z.array(ScheduleEntrySchema).max(14).optional(),
  settings: z
    .object({
      notifications: z.boolean().optional(),
      darkMode: z.boolean().optional(),
      privacyMode: z.boolean().optional(),
    })
    .optional(),
  displayName: z.string().min(1).max(100).optional(),
});

router.patch('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = UpdateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { dailyGoal, preferredApps, schedule, settings, displayName } = parsed.data;

  try {
    // Update profile columns that were provided
    if (
      dailyGoal !== undefined ||
      preferredApps !== undefined ||
      schedule !== undefined ||
      settings !== undefined
    ) {
      await sql`
        UPDATE profiles SET
          daily_goal     = COALESCE(${dailyGoal ?? null}, daily_goal),
          preferred_apps = COALESCE(${preferredApps ?? null}, preferred_apps),
          schedule       = COALESCE(
                             ${schedule ? JSON.stringify(schedule) : null}::jsonb,
                             schedule
                           ),
          settings       = CASE
                             WHEN ${settings ? JSON.stringify(settings) : null}::jsonb IS NOT NULL
                             THEN settings || ${settings ? JSON.stringify(settings) : '{}'}::jsonb
                             ELSE settings
                           END,
          updated_at     = NOW()
        WHERE user_id = ${req.userId!}
      `;
    }

    if (displayName !== undefined) {
      await sql`
        UPDATE users SET display_name = ${displayName}
        WHERE id = ${req.userId!}
      `;
    }

    // Return updated profile
    const updated = await queryOne<{
      user_id: string;
      daily_goal: number;
      preferred_apps: string[];
      schedule: unknown;
      settings: unknown;
      display_name: string;
      email: string;
      photo_url: string | null;
    }>`
      SELECT p.user_id, p.daily_goal, p.preferred_apps, p.schedule, p.settings,
             u.display_name, u.email, u.photo_url
      FROM profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ${req.userId!}
    `;

    res.json({
      userId: updated!.user_id,
      dailyGoal: updated!.daily_goal,
      preferredApps: updated!.preferred_apps,
      schedule: updated!.schedule,
      settings: updated!.settings,
      displayName: updated!.display_name,
      email: updated!.email,
      photoUrl: updated!.photo_url,
    });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /profile ───────────────────────────────────────────────────────────

router.delete('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await sql`DELETE FROM users WHERE id = ${req.userId!}`;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
