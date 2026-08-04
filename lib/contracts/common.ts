import { z } from "zod";

export const finiteNumberSchema = z.number().finite();

export const orderedRangeSchema = z
  .object({ min: finiteNumberSchema, max: finiteNumberSchema })
  .refine(({ min, max }) => min <= max, { message: "Minimum must not exceed maximum" });

export const isoDateSchema = z.string().datetime({ offset: true });

export const accessStateSchema = z.enum(["public", "unknown", "private", "closed", "prohibited"]);
export const confidenceSchema = z.enum(["high", "medium", "low"]);
