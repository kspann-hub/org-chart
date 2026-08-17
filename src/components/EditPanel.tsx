import { useEffect, useRef, useState } from 'react'
import type { ChartNode, Employee, Group } from '../lib/types'
import { removeHeadshot, uploadHeadshot } from '../lib/photos'
import { normaliseLinkedIn } from '../lib/linkedin'
import { Avatar } from './Avatar'

type Props = {
  node: ChartNode
  directory: Employee[]
  /** Every seat, for the "Reports to" picker. */
  allNodes: ChartNode[]
  /** Seats this one may not report to: itself and its own reports. */
  forbiddenIds: Set<string>
  childCount: number
  /** The group rooted at this seat, if it is a group root. */
  group: Group | null
  onSave: (patch: Record<string, unknown>) => Promise<void>
  onSaveGroup: (group: { name: string; accent: string } | null) => Promise<void>
  onAddChild: () => void
  onDelete: () => void
  onClose: () => void
}

const ACCENTS = ['#3b82f6', '#38bdf8', '#4ade80', '#f472b6', '#fbbf24', '#a78bfa']

export function EditPanel(props: Props) {
  const { node, directory } = props

  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [showTitle, setShowTitle] = useState(true)
  const [employeeKey, setEmployeeKey] = useState('')
  const [linkedin, setLinkedin] = useState('')
  const [parentId, setParentId] = useState('')
  const [isGroup, setIsGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [accent, setAccent] = useState(ACCENTS[0])

  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Reload the form whenever a different seat is selected.
  useEffect(() => {
    setName(node.position.name_override ?? '')
    setTitle(node.position.title_override ?? '')
    setShowTitle(node.position.show_title)
    setEmployeeKey(node.position.employee_key ?? '')
    setLinkedin(node.position.linkedin_url ?? '')
    setParentId(node.position.parent_id ?? '')
    setIsGroup(Boolean(props.group))
    setGroupName(props.group?.name ?? '')
    setAccent(props.group?.accent ?? ACCENTS[0])
    setError(null)
  }, [node.id, node.position, props.group])

  const person = node.employee

  async function save() {
    setSaving(true)
    setError(null)
    try {
      // Normalising here, before anything is written, means a mistyped link
      // stops the save with a readable message rather than being stored and
      // then quietly refused by the database's CHECK constraint.
      const linkedinUrl = normaliseLinkedIn(linkedin)

      await props.onSave({
        // Empty string means "no override" — store null so the Ajera value
        // shows through, rather than blanking the box out.
        name_override: name.trim() || null,
        title_override: title.trim() || null,
        show_title: showTitle,
        employee_key: employeeKey || null,
        parent_id: parentId || null,
        linkedin_url: linkedinUrl,
      })
      setLinkedin(linkedinUrl ?? '')
      await props.onSaveGroup(
        isGroup ? { name: groupName.trim() || node.name, accent } : null,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function onPickPhoto(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Pick an image file.')
      return
    }
    // uploadHeadshot downscales in the browser, so what gets stored is ~20 KB
    // whatever comes in here and a big original is no longer a problem for the
    // chart. This only guards against decoding something absurd into memory.
    if (file.size > 25_000_000) {
      setError('That image is over 25 MB. Please use a smaller one.')
      return
    }

    setUploading(true)
    setError(null)
    const previous = node.position.photo_path
    try {
      const path = await uploadHeadshot(node.id, file)
      await props.onSave({ photo_path: path })
      await removeHeadshot(previous)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function clearPhoto() {
    const previous = node.position.photo_path
    await props.onSave({ photo_path: null })
    await removeHeadshot(previous)
  }

  const active = directory
    .filter((e) => e.employment_status === 'Active')
    .sort((a, b) => a.full_name.localeCompare(b.full_name))

  const managers = props.allNodes
    .filter((n) => !props.forbiddenIds.has(n.id))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <h2>{node.name}</h2>
          {node.title && <p className="panel-sub">{node.title}</p>}
        </div>
        <button className="btn-quiet" onClick={props.onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="field">
        <span className="field-label">Photo</span>
        <div className="photo-row">
          <Avatar node={node} size={56} />
          <div className="photo-actions">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              onChange={(e) => void onPickPhoto(e.target.files?.[0])}
            />
            {node.position.photo_path && (
              <button className="btn-link" onClick={() => void clearPhoto()}>
                Remove photo
              </button>
            )}
          </div>
        </div>
        {uploading && <small>Uploading…</small>}
      </div>

      <label>
        <span>Person</span>
        <select value={employeeKey} onChange={(e) => setEmployeeKey(e.target.value)}>
          <option value="">— Vacant seat —</option>
          {/* A seat pointing at someone no longer Active still needs to show
              them here, or saving would silently detach the person. */}
          {person && person.employment_status !== 'Active' && (
            <option value={person.employee_key}>{person.full_name} (not active)</option>
          )}
          {active.map((e) => (
            <option key={e.employee_key} value={e.employee_key}>
              {e.full_name}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>Display name</span>
        <input
          value={name}
          placeholder={person?.full_name ?? 'Vacant'}
          onChange={(e) => setName(e.target.value)}
        />
        <small>
          {person
            ? `Blank uses the Ajera name: ${person.full_name}`
            : 'Name this placeholder, e.g. "Open req — Project Engineer".'}
        </small>
      </label>

      <label>
        <span>Title</span>
        <input
          value={title}
          placeholder={person?.employee_title ?? ''}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!showTitle}
        />
        <small>
          {person?.employee_title
            ? `Blank uses the Ajera title: ${person.employee_title}`
            : 'Ajera has no title for this person; set one here.'}
        </small>
      </label>

      <label className="row">
        <input
          type="checkbox"
          checked={showTitle}
          onChange={(e) => setShowTitle(e.target.checked)}
        />
        <span>Show a title on this box</span>
      </label>

      <label>
        <span>LinkedIn profile</span>
        <input
          value={linkedin}
          placeholder="https://www.linkedin.com/in/jane-doe"
          onChange={(e) => setLinkedin(e.target.value)}
        />
        <small>
          Paste the address from their profile page. A small LinkedIn badge then
          appears on the corner of their photo, and clicking it opens the profile
          in a new tab. Leave it blank for no badge.
        </small>
      </label>

      <label>
        <span>Reports to</span>
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">— Top of the chart —</option>
          {managers.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
              {n.title ? ` — ${n.title}` : ''}
            </option>
          ))}
        </select>
        <small>Their own reports are excluded, since that would make a loop.</small>
      </label>

      <div className="field">
        <label className="row">
          <input
            type="checkbox"
            checked={isGroup}
            onChange={(e) => setIsGroup(e.target.checked)}
          />
          <span>Start a group here</span>
        </label>
        <small>
          Everyone below this seat forms a card on the home page — except anyone who
          falls under a group started further down.
        </small>

        {isGroup && (
          <>
            <input
              value={groupName}
              placeholder="Group name, e.g. Project Delivery"
              onChange={(e) => setGroupName(e.target.value)}
            />
            <div className="accent-row">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  className={`accent-dot ${accent === c ? 'is-on' : ''}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => setAccent(c)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {error && <p className="panel-error">{error}</p>}

      <div className="panel-actions">
        <button className="btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn-quiet" onClick={props.onAddChild}>
          Add a report
        </button>
      </div>

      <div className="panel-danger">
        <button className="btn-danger" onClick={props.onDelete}>
          Remove from chart
        </button>
        {props.childCount > 0 && (
          <small>
            Its {props.childCount} direct report{props.childCount === 1 ? '' : 's'} move up
            one level rather than being deleted.
          </small>
        )}
      </div>

      <dl className="panel-meta">
        {person?.employee_email && (
          <>
            <dt>Email</dt>
            <dd>
              <a href={`mailto:${person.employee_email}`}>{person.employee_email}</a>
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          Name and title come from Ajera unless overridden above. Photos live in Supabase
          Storage and are never touched by the Ajera sync.
        </dd>
        <dt>Last edited</dt>
        <dd>
          {new Date(node.position.updated_at).toLocaleString()}
          {node.position.updated_by ? ` by ${node.position.updated_by}` : ''}
        </dd>
      </dl>
    </aside>
  )
}
