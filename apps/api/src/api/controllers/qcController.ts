import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { listQuery } from "../../plugins/fetch/index.js";
import { requireQcContext } from "../middleware/qcAuth.js";
import {
  createQcFlow,
  createQcProject,
  createQcTestCase,
  deleteQcFlow,
  deleteQcProject,
  deleteQcSampleFile,
  deleteQcTestCase,
  getQcFlow,
  getQcSampleFileStream,
  getQcTestCase,
  listQcFlows,
  listQcProjects,
  listQcSampleFiles,
  listQcTestCases,
  saveQcSampleFile,
  updateQcFlow,
  updateQcProject,
  updateQcTestCase,
} from "../../modules/qc/index.js";
import type { QcFlowStep, QcExecutionPlanItem } from "../../modules/qc/types.js";

function username(): string {
  return requireQcContext().username;
}

function qcProjectId(): string {
  const id = requireQcContext().qcProjectId;
  if (!id) throw new AppError("X-Qc-Project header required", 400);
  return id;
}

export const qcController = {
  listProjects: asyncHandler(async (req: Request, res: Response) => {
    const q = listQuery(req, { sort: { updatedAt: -1 } });
    const { rows, count } = await listQcProjects(username(), q);
    res.formatter.ok(
      { projects: rows, count },
      { sort: q.sort, skip: q.skip, limit: q.limit },
    );
  }),

  createProject: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: string;
      targetBaseUrl?: string;
    };
    const project = await createQcProject({
      username: username(),
      name: String(body.name || ""),
      targetBaseUrl: String(body.targetBaseUrl || ""),
    });
    res.formatter.created(project);
  }),

  updateProject: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: string;
      targetBaseUrl?: string;
    };
    res.formatter.ok(
      await updateQcProject({
        username: username(),
        projectId: String(req.params.projectId || ""),
        name: body.name,
        targetBaseUrl: body.targetBaseUrl,
      }),
    );
  }),

  deleteProject: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await deleteQcProject({
        username: username(),
        projectId: String(req.params.projectId || ""),
      }),
    );
  }),

  listFlows: asyncHandler(async (req: Request, res: Response) => {
    const q = listQuery(req, { sort: { updatedAt: -1 } });
    const { rows, count } = await listQcFlows({
      username: username(),
      qcProjectId: qcProjectId(),
      list: q,
    });
    res.formatter.ok(
      { flows: rows, count },
      { sort: q.sort, skip: q.skip, limit: q.limit },
    );
  }),

  getFlow: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await getQcFlow({
        username: username(),
        flowId: String(req.params.flowId || ""),
      }),
    );
  }),

  createFlow: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: string;
      steps?: QcFlowStep[];
      qcProjectId?: string;
    };
    const projectId = body.qcProjectId?.trim() || qcProjectId();
    res.formatter.created(
      await createQcFlow({
        username: username(),
        qcProjectId: projectId,
        name: String(body.name || ""),
        steps: body.steps,
      }),
    );
  }),

  updateFlow: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: string;
      steps?: QcFlowStep[];
    };
    res.formatter.ok(
      await updateQcFlow({
        username: username(),
        flowId: String(req.params.flowId || ""),
        name: body.name,
        steps: body.steps,
      }),
    );
  }),

  deleteFlow: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await deleteQcFlow({
        username: username(),
        flowId: String(req.params.flowId || ""),
      }),
    );
  }),

  listTestCases: asyncHandler(async (req: Request, res: Response) => {
    const q = listQuery(req, { sort: { updatedAt: -1 } });
    const { rows, count } = await listQcTestCases({
      username: username(),
      qcProjectId: qcProjectId(),
      list: q,
    });
    res.formatter.ok(
      { testCases: rows, count },
      { sort: q.sort, skip: q.skip, limit: q.limit },
    );
  }),

  getTestCase: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await getQcTestCase({
        username: username(),
        testCaseId: String(req.params.testCaseId || ""),
      }),
    );
  }),

  createTestCase: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: string;
      loopCount?: number;
      executionPlan?: QcExecutionPlanItem[];
      qcProjectId?: string;
    };
    const projectId = body.qcProjectId?.trim() || qcProjectId();
    res.formatter.created(
      await createQcTestCase({
        username: username(),
        qcProjectId: projectId,
        name: String(body.name || ""),
        loopCount: body.loopCount,
        executionPlan: body.executionPlan,
      }),
    );
  }),

  updateTestCase: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: string;
      loopCount?: number;
      executionPlan?: QcExecutionPlanItem[];
    };
    res.formatter.ok(
      await updateQcTestCase({
        username: username(),
        testCaseId: String(req.params.testCaseId || ""),
        name: body.name,
        loopCount: body.loopCount,
        executionPlan: body.executionPlan,
      }),
    );
  }),

  deleteTestCase: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await deleteQcTestCase({
        username: username(),
        testCaseId: String(req.params.testCaseId || ""),
      }),
    );
  }),

  listSampleFiles: asyncHandler(async (req: Request, res: Response) => {
    const q = listQuery(req, { sort: { createdAt: -1 } });
    const { rows, count } = await listQcSampleFiles({
      username: username(),
      qcProjectId: qcProjectId(),
      list: q,
    });
    res.formatter.ok(
      { files: rows, count },
      { sort: q.sort, skip: q.skip, limit: q.limit },
    );
  }),

  uploadSampleFile: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      originalName?: string;
      mimeType?: string;
      contentBase64?: string;
      qcProjectId?: string;
    };
    const b64 = String(body.contentBase64 || "");
    if (!b64) throw new AppError("contentBase64 required", 400);
    const buffer = Buffer.from(b64, "base64");
    if (!buffer.length) throw new AppError("empty file", 400);
    const projectId = body.qcProjectId?.trim() || qcProjectId();
    res.formatter.created(
      await saveQcSampleFile({
        username: username(),
        qcProjectId: projectId,
        originalName: String(body.originalName || "upload.bin"),
        mimeType: String(body.mimeType || "application/octet-stream"),
        buffer,
      }),
    );
  }),

  downloadSampleFile: asyncHandler(async (req: Request, res: Response) => {
    const { doc, stream } = await getQcSampleFileStream({
      username: username(),
      fileId: String(req.params.fileId || ""),
    });
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(doc.originalName)}"`,
    );
    stream.pipe(res);
  }),

  deleteSampleFile: asyncHandler(async (req: Request, res: Response) => {
    res.formatter.ok(
      await deleteQcSampleFile({
        username: username(),
        fileId: String(req.params.fileId || ""),
      }),
    );
  }),
};
