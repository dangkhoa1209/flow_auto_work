import type {
  Collection,
  CreateIndexesOptions,
  Document,
  Filter,
  OptionalUnlessRequiredId,
  Sort,
  WithId,
} from "mongodb";
import { connectMongo } from "./connection.js";
import { logger } from "../logger.js";

/** Soft-delete fields mixed into documents when softDelete is enabled. */
export type SoftDeleteFields = {
  deleted?: boolean;
  deletedAt?: string | null;
};

export type FindManyOpts<T extends Document> = {
  filter?: Filter<T>;
  sort?: Sort;
  skip?: number;
  limit?: number;
  /** Include soft-deleted rows */
  withDeleted?: boolean;
};

export type ModelIndexSpec = {
  keys: Record<string, 1 | -1>;
  options?: CreateIndexesOptions & {
    /**
     * Unique only among non-deleted docs (`deleted !== true`).
     * Required for soft-delete + unique (username, slug, job issue, …).
     */
    softUnique?: boolean;
  };
};

export type ModelApi<T extends Document> = {
  collectionName: string;
  softDelete: boolean;
  col: () => Promise<Collection<T>>;
  ensureIndexes: () => Promise<void>;
  findMany: (opts?: FindManyOpts<T>) => Promise<WithId<T>[]>;
  count: (opts?: {
    filter?: Filter<T>;
    withDeleted?: boolean;
  }) => Promise<number>;
  findById: (
    id: string,
    opts?: { withDeleted?: boolean },
  ) => Promise<WithId<T> | null>;
  findOne: (
    filter: Filter<T>,
    opts?: { withDeleted?: boolean },
  ) => Promise<WithId<T> | null>;
  insert: (doc: OptionalUnlessRequiredId<T>) => Promise<WithId<T>>;
  updateById: (
    id: string,
    patch: Partial<T>,
  ) => Promise<WithId<T> | null>;
  softDeleteById: (id: string) => Promise<boolean>;
  softDeleteMany: (filter: Filter<T>) => Promise<number>;
  forceDeleteById: (id: string) => Promise<boolean>;
  forceDeleteMany: (filter: Filter<T>) => Promise<number>;
};

export type CreateModelOpts = {
  collection: string;
  softDelete?: boolean;
  defaultSort?: Sort;
  parseId?: (id: string) => unknown;
  indexes?: ModelIndexSpec[];
};

/** Match docs that are not soft-deleted (missing `deleted` or `false`). */
export function activeFilter<T extends Document = Document>(): Filter<T> {
  return {
    $or: [{ deleted: { $exists: false } }, { deleted: false }],
  } as Filter<T>;
}

/** Merge a query with the active (non-deleted) filter. */
export function withActive<T extends Document>(
  filter?: Filter<T>,
): Filter<T> {
  const soft = activeFilter<T>();
  if (!filter || Object.keys(filter).length === 0) return soft;
  return { $and: [filter, soft] } as Filter<T>;
}

function notDeletedFilter<T extends Document>(
  softDelete: boolean,
  withDeleted?: boolean,
): Filter<T> {
  if (!softDelete || withDeleted) return {} as Filter<T>;
  return activeFilter<T>();
}

function mergeFilter<T extends Document>(
  softDelete: boolean,
  filter: Filter<T> | undefined,
  withDeleted?: boolean,
): Filter<T> {
  const soft = notDeletedFilter<T>(softDelete, withDeleted);
  if (!filter || Object.keys(filter).length === 0) return soft;
  if (Object.keys(soft).length === 0) return filter;
  return { $and: [filter, soft] } as Filter<T>;
}

/**
 * Unique among active rows only — soft-deleted rows do not collide.
 * Mongo partial indexes only allow equality / range — not `$ne` or `$exists: false`.
 */
export function softUniquePartialFilter(): Document {
  return { deleted: false };
}

async function normalizeSoftDeleteField(c: Collection<Document>): Promise<void> {
  const result = await c.updateMany(
    { $or: [{ deleted: { $exists: false } }, { deleted: null }] },
    { $set: { deleted: false, deletedAt: null } },
  );
  if (result.modifiedCount > 0) {
    logger.info("Normalized legacy soft-delete field", {
      collection: c.collectionName,
      count: result.modifiedCount,
    });
  }
}

export function softUniqueOptions(
  name: string,
  extra?: CreateIndexesOptions,
): CreateIndexesOptions {
  return {
    ...extra,
    name,
    unique: true,
    partialFilterExpression: softUniquePartialFilter(),
  };
}

async function createIndexSafe(
  c: Collection<Document>,
  keys: Record<string, 1 | -1>,
  options: CreateIndexesOptions,
): Promise<void> {
  const name = options.name;
  try {
    await c.createIndex(keys, options);
  } catch (err) {
    const msg = String(err);
    // Index exists with different options (e.g. old unique without partial) — recreate.
    if (name && /already exists|IndexKeySpecsConflict|IndexOptionsConflict/i.test(msg)) {
      try {
        await c.dropIndex(name);
      } catch {
        /* ignore */
      }
      try {
        await c.createIndex(keys, options);
        logger.info("Recreated Mongo index for soft-delete", {
          collection: c.collectionName,
          name,
        });
        return;
      } catch (err2) {
        logger.warn("Failed to recreate Mongo index", {
          collection: c.collectionName,
          name,
          err: String(err2),
        });
        throw err2;
      }
    }
    throw err;
  }
}

/**
 * Native-Mongo model factory (HTS AppModel-inspired, no Mongoose).
 * Soft-delete excludes `deleted: true` from reads unless `withDeleted`.
 * Unique indexes with `softUnique` use partialFilterExpression so deletes don't block re-create.
 */
export function createModel<T extends Document>(
  opts: CreateModelOpts,
): ModelApi<T> {
  const softDelete = opts.softDelete ?? false;
  const defaultSort: Sort = opts.defaultSort ?? { updatedAt: -1 };
  const parseId = opts.parseId ?? ((id: string) => id);
  let indexesReady = false;

  async function col(): Promise<Collection<T>> {
    const db = await connectMongo();
    return db.collection<T>(opts.collection);
  }

  async function ensureIndexes(): Promise<void> {
    if (indexesReady) return;
    const c = (await col()) as unknown as Collection<Document>;
    if (softDelete) {
      await normalizeSoftDeleteField(c);
    }
    if (opts.indexes?.length) {
      for (const idx of opts.indexes) {
        const { softUnique, ...rest } = idx.options ?? {};
        let options: CreateIndexesOptions = { ...rest };
        if (softUnique) {
          if (!softDelete) {
            throw new Error(
              `softUnique requires softDelete on model ${opts.collection}`,
            );
          }
          const name =
            (typeof options.name === "string" && options.name) ||
            `${Object.keys(idx.keys).join("_")}_soft_unique`;
          options = softUniqueOptions(name, options);
        }
        await createIndexSafe(c, idx.keys, options);
      }
    }
    if (softDelete) {
      await createIndexSafe(c, { deleted: 1 }, { name: "deleted_1" });
    }
    indexesReady = true;
  }

  return {
    collectionName: opts.collection,
    softDelete,
    col,
    ensureIndexes,

    async findMany(findOpts = {}) {
      await ensureIndexes();
      const filter = mergeFilter(
        softDelete,
        findOpts.filter,
        findOpts.withDeleted,
      );
      let cursor = (await col())
        .find(filter)
        .sort(findOpts.sort ?? defaultSort);
      if (findOpts.skip) cursor = cursor.skip(findOpts.skip);
      if (findOpts.limit != null) cursor = cursor.limit(findOpts.limit);
      return cursor.toArray();
    },

    async count(countOpts = {}) {
      await ensureIndexes();
      const filter = mergeFilter(
        softDelete,
        countOpts.filter,
        countOpts.withDeleted,
      );
      return (await col()).countDocuments(filter);
    },

    async findById(id, findOpts) {
      await ensureIndexes();
      const filter = mergeFilter(
        softDelete,
        { _id: parseId(id) } as Filter<T>,
        findOpts?.withDeleted,
      );
      return (await col()).findOne(filter);
    },

    async findOne(filter, findOpts) {
      await ensureIndexes();
      return (await col()).findOne(
        mergeFilter(softDelete, filter, findOpts?.withDeleted),
      );
    },

    async insert(doc) {
      await ensureIndexes();
      const c = await col();
      const payload = softDelete
        ? ({ ...doc, deleted: false, deletedAt: null } as OptionalUnlessRequiredId<T>)
        : doc;
      const result = await c.insertOne(payload);
      const inserted = await c.findOne({
        _id: result.insertedId,
      } as Filter<T>);
      if (!inserted) {
        throw new Error(`insert failed for ${opts.collection}`);
      }
      return inserted;
    },

    async updateById(id, patch) {
      await ensureIndexes();
      const c = await col();
      await c.updateOne({ _id: parseId(id) } as Filter<T>, {
        $set: patch as Partial<T>,
      });
      return c.findOne(
        mergeFilter(
          softDelete,
          { _id: parseId(id) } as Filter<T>,
          false,
        ),
      );
    },

    async softDeleteById(id) {
      if (!softDelete) {
        return this.forceDeleteById(id);
      }
      await ensureIndexes();
      const result = await (await col()).updateOne(
        { _id: parseId(id) } as Filter<T>,
        {
          $set: {
            deleted: true,
            deletedAt: new Date().toISOString(),
          } as unknown as Partial<T>,
        },
      );
      return result.matchedCount > 0;
    },

    async softDeleteMany(filter) {
      if (!softDelete) {
        return this.forceDeleteMany(filter);
      }
      await ensureIndexes();
      const result = await (await col()).updateMany(filter, {
        $set: {
          deleted: true,
          deletedAt: new Date().toISOString(),
        } as unknown as Partial<T>,
      });
      return result.modifiedCount;
    },

    async forceDeleteById(id) {
      await ensureIndexes();
      const result = await (await col()).deleteOne({
        _id: parseId(id),
      } as Filter<T>);
      return result.deletedCount > 0;
    },

    async forceDeleteMany(filter) {
      await ensureIndexes();
      const result = await (await col()).deleteMany(filter);
      return result.deletedCount;
    },
  };
}
