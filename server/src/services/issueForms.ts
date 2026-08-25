import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { AppConfig } from '../config.js'
import type { ProjectRow, IssueRow } from '../db/store.js'
import type { Actor } from '../authz.js'
import { can } from '../authz.js'
import type { RepositoriesService } from './repositories.js'
import type { IssuesService } from './issues.js'
import type { LocalHashedStorage } from '../storage/local.js'
import { parseSafeYaml, YamlParseError, DEFAULT_YAML_LIMITS } from '../lib/yaml.js'
import {
  FORM_LIMITS,
  validateFormSchema,
  validateAnswers,
  renderIssueBody,
  resolveIssueTitle,
  type IssueFormDef,
} from '../lib/forms.js'

/**
 * Configurable issue forms.
 *
 * Templates are versioned repository files at `.lsgit/issues/forms/<name>.yml`
 * on the project's default branch — the same storage plane as code, so forms
 * inherit history, review and rollback for free (GitLab keeps its templates in
 * the repo too; our path namespace is LSGit-native).
 *
 * Security posture:
 *  - YAML is parsed by the in-house safe-subset parser; nothing executes.
 *  - Templates are validated BEFORE they are committed, so an invalid or
 *    hostile template can never be stored.
 *  - Submissions re-validate answers server-side against the stored schema;
 *    client-side validation is convenience only.
 */

export const FORMS_DIR = '.lsgit/issues/forms'

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface FormSummary {
  name: string
  title: string
  description: string
  field_count: number
}

export interface FormListEntry extends FormSummary {
  valid: boolean
  error?: string
}

export class IssueFormsService {
  constructor(
    private s: IdentityServices,
    private cfg: AppConfig,
    private storage: LocalHashedStorage,
    private repos: RepositoriesService,
    private issues: IssuesService,
  ) {}

  // -- authorization -----------------------------------------------------------

  private projectCtx(project: ProjectRow) {
    return {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility,
        archived: !!project.archived,
      },
    }
  }

  private requireReadable(actor: Actor | null, projectId: number): ProjectRow {
    const p = this.s.projects.byId(projectId)
    if (!p) throw new AppError(404, 'Project not found')
    try {
      if (!can(actor, 'project:read', this.projectCtx(p))) {
        throw new AppError(actor ? 403 : 401, 'Not allowed', actor ? 'forbidden' : 'unauthenticated')
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'forbidden') {
        // Existence hidden from non-readers (PERMISSIONS.md §2).
        throw new AppError(404, 'Project not found')
      }
      throw err
    }
    return p
  }

  private requireMaintainer(actor: Actor | null, project: ProjectRow): void {
    if (!can(actor, 'issue_forms:maintain', this.projectCtx(project))) {
      throw new AppError(actor ? 403 : 401, 'Only maintainers can manage issue forms', 'forbidden')
    }
  }

  private formPath(name: string): string {
    if (!NAME_PATTERN.test(name)) throw new AppError(400, 'Form name must match [a-z0-9][a-z0-9_-]*', 'invalid_name')
    return `${FORMS_DIR}/${name}.yml`
  }

  // -- template persistence ------------------------------------------------------

  /** Reads every stored template file. Missing/empty repositories yield []. */
  private readTemplates(project: ProjectRow): Array<{ name: string; yaml: string }> {
    try {
      const files = this.storage.readBranchFiles(project.disk_path, project.default_branch)
      const out: Array<{ name: string; yaml: string }> = []
      for (const [path, content] of files) {
        if (!path.startsWith(`${FORMS_DIR}/`)) continue
        if (!/\.ya?ml$/i.test(path)) continue
        const base = path.slice(FORMS_DIR.length + 1).replace(/\.ya?ml$/i, '')
        out.push({ name: base.toLowerCase(), yaml: content.toString('utf8') })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return [] // empty repository / missing branch → no templates
    }
  }

  private parseTemplate(yamlText: string): { def?: IssueFormDef; error?: string } {
    try {
      const doc = parseSafeYaml(yamlText, {
        maxBytes: Math.min(this.cfg.maxIssueFormBytes ?? FORM_LIMITS.maxTemplateBytes, FORM_LIMITS.maxTemplateBytes),
        maxDepth: DEFAULT_YAML_LIMITS.maxDepth,
        maxNodes: DEFAULT_YAML_LIMITS.maxNodes,
      })
      return { def: validateFormSchema(doc) }
    } catch (err) {
      const message = err instanceof YamlParseError || err instanceof AppError
        ? err.message
        : 'Template could not be parsed'
      return { error: message }
    }
  }

  listForms(actor: Actor | null, projectId: number): FormListEntry[] {
    const project = this.requireReadable(actor, projectId)
    const out: FormListEntry[] = []
    for (const { name, yaml } of this.readTemplates(project)) {
      if (Buffer.byteLength(yaml, 'utf8') > FORM_LIMITS.maxTemplateBytes) {
        out.push({ name, title: name, description: '', field_count: 0, valid: false, error: 'template too large' })
        continue
      }
      const parsed = this.parseTemplate(yaml)
      if (parsed.error || !parsed.def) {
        out.push({ name, title: name, description: '', field_count: 0, valid: false, error: parsed.error })
        continue
      }
      out.push({
        name,
        title: parsed.def.name,
        description: parsed.def.description,
        field_count: parsed.def.fields.length,
        valid: true,
      })
    }
    return out
  }

  getForm(actor: Actor | null, projectId: number, name: string): IssueFormDef & { raw_name: string } {
    const project = this.requireReadable(actor, projectId)
    const entry = this.readTemplates(project).find((t) => t.name === name.toLowerCase())
    if (!entry) throw new AppError(404, 'Issue form not found')
    const parsed = this.parseTemplate(entry.yaml)
    if (parsed.error || !parsed.def) {
      throw new AppError(422, `Stored form is invalid: ${parsed.error}`, 'form_invalid')
    }
    return { ...parsed.def, raw_name: entry.name }
  }

  saveForm(actor: Actor, projectId: number, name: string, yamlText: unknown): { path: string; commit_sha: string; form: IssueFormDef } {
    const project = this.requireReadable(actor, projectId)
    this.requireMaintainer(actor, project)
    const path = this.formPath(name)

    if (typeof yamlText !== 'string' || yamlText.trim() === '') {
      throw new AppError(400, 'yaml body is required', 'validation_failed')
    }
    // Validate BEFORE committing — invalid templates are never stored.
    const parsed = this.parseTemplate(yamlText)
    if (parsed.error || !parsed.def) {
      throw new AppError(400, `Invalid form template: ${parsed.error}`, 'form_schema_invalid')
    }

    const verb = this.readTemplates(project).some((t) => t.name === name.toLowerCase())
      ? 'update'
      : 'add'
    const outcome = this.repos.commitChanges(actor, projectId, {
      branch: project.default_branch,
      message: `chore(forms): ${verb} issue form '${name}'`,
      changes: [{ path, content: yamlText }],
    })
    return { path, commit_sha: outcome.commit_sha, form: parsed.def }
  }

  deleteForm(actor: Actor, projectId: number, name: string): { commit_sha: string } {
    const project = this.requireReadable(actor, projectId)
    this.requireMaintainer(actor, project)
    const path = this.formPath(name)

    const exists = this.readTemplates(project).some((t) => t.name === name.toLowerCase())
    if (!exists) throw new AppError(404, 'Issue form not found')

    const outcome = this.repos.commitChanges(actor, projectId, {
      branch: project.default_branch,
      message: `chore(forms): remove issue form '${name}'`,
      changes: [{ path, delete: true }],
    })
    return { commit_sha: outcome.commit_sha }
  }

  // -- submission ------------------------------------------------------------------

  /**
   * Validates a submission against the stored schema and creates the issue:
   * structured Markdown body (+ task-list fields), configured labels that
   * exist on the project, prefixed title. Server-side validation is the only
   * authority — the client mirrors it for UX alone.
   */
  submit(
    actor: Actor,
    projectId: number,
    formName: string,
    payload: { title?: unknown; answers?: unknown },
  ): { issue: IssueRow; form: IssueFormDef } {
    const form = this.getForm(actor, projectId, formName)

    const answers = validateAnswers(form, payload.answers)
    const body = renderIssueBody(form, answers)
    const title = resolveIssueTitle(form, answers, payload.title)

    // Configured labels apply only when they exist (GitLab-lenient behavior).
    const existing = new Set(this.s.labels.listForProject(projectId).map((l) => l.title))
    const labels = form.labels.filter((l) => existing.has(l))

    const issue = this.issues.create(actor, projectId, { title, description: body, labels })

    this.s.events.emit(projectId, 'form.submitted', {
      action: 'submitted',
      form: form.name,
      iid: issue.iid,
      actor_user_id: actor.userId,
      participant_user_ids: [actor.userId],
    })
    return { issue, form }
  }
}
