import { fail } from '@sveltejs/kit';
import { backfillSchema, installCorrectionSchema, withdrawSchema } from '$lib/models/recalc';

function failure(error: { issues: Array<{ message: string }> }) {
  return fail(400, {
    message: error.issues[0]?.message ?? '表单校验失败'
  });
}

export const actions = {
  backfill: async ({ request }) => {
    const parsed = backfillSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return failure(parsed.error);
    return { success: true, backfill: { ...parsed.data } };
  },

  withdraw: async ({ request }) => {
    const parsed = withdrawSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return failure(parsed.error);
    return { success: true, withdraw: { ...parsed.data } };
  },

  install: async ({ request }) => {
    const parsed = installCorrectionSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return failure(parsed.error);
    return { success: true, install: { ...parsed.data } };
  }
};
