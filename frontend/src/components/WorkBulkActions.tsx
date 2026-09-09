import { useState } from 'react';
import { api } from '../api';
import { getActiveWorkspaceId } from '../api/client';
export function WorkBulkActions({
  ids,
  members,
  disabled,
  onComplete,
  onError,
  onBusy,
}: {
  ids: string[];
  members: Array<{ user_id: string; name?: string | null; email: string }>;
  disabled: boolean;
  onComplete: () => Promise<void>;
  onError: (message: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [assignee, setAssignee] = useState('');
  async function apply(changes: Record<string, unknown>, label: string) {
    const workspace = getActiveWorkspaceId();
    setBusy(true);
    onBusy?.(true);
    try {
      const preview = await api.bulkWorkItems(ids, changes, true);
      if (!window.confirm(`${label} for ${preview.affected ?? 0} selected work items?`)) return;
      if (getActiveWorkspaceId() !== workspace)
        throw new Error('Workspace changed. Select the work items again.');
      await api.bulkWorkItems(ids, changes);
      await onComplete();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }
  return (
    <div className="bulk-bar work-bulk-actions" aria-label="Selected work actions">
      <strong>{ids.length} selected (maximum 200)</strong>
      {(
        [
          ['in_progress', 'Start work'],
          ['done', 'Mark resolved'],
          ['dismissed', 'Dismiss'],
          ['open', 'Reopen'],
        ] as const
      ).map(([status, label]) => (
        <button
          key={status}
          className="btn btn-secondary btn-sm"
          disabled={disabled || busy}
          onClick={() => apply({ status }, label)}
        >
          {label}
        </button>
      ))}
      <label>
        Assign selected
        <select
          aria-label="Assign selected work"
          disabled={disabled || busy}
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        >
          <option value="">Choose assignee</option>
          <option value="unassigned">Unassigned</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.name || m.email}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn btn-secondary btn-sm"
        disabled={disabled || busy || !assignee}
        onClick={() =>
          apply({ assignee_user_id: assignee === 'unassigned' ? null : assignee }, 'Change assignee')
        }
      >
        Apply assignee
      </button>
    </div>
  );
}
