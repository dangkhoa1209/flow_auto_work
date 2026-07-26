import { addNote, listNotes } from "../../db/mongo.js";
import { resolveGitlabProjectPath } from "../../workspace/creds.js";
import { AppError } from "../../utils/AppError.js";

export async function listNotesForUi(opts: {
  issueIid?: number;
  jobId?: string;
}) {
  const notes = await listNotes({
    issueIid: opts.issueIid,
    jobId: opts.jobId,
    limit: 100,
  });
  return { notes };
}

export async function createNote(body: {
  issueIid?: number;
  jobId?: string;
  body?: string;
}) {
  if (!body.body?.trim() || body.issueIid === undefined) {
    throw new AppError("issueIid and body required", 400);
  }
  const note = await addNote({
    jobId: body.jobId,
    issueIid: Number(body.issueIid),
    projectPath: resolveGitlabProjectPath(),
    body: body.body,
  });
  return { note };
}
