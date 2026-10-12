/** Stacked bar: picked up (green), not out (orange), pending (grey). */
export default function Progress({ counts, large = false }) {
  const { total, picked_up: picked, not_out: notOut } = counts;
  const pct = (n) => (total ? (n / total) * 100 : 0);
  const done = picked + notOut;
  return (
    <div className={`progress${large ? ' large' : ''}`}>
      <div
        className="progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={`${done} of ${total} stops done`}
      >
        <span className="seg picked" style={{ width: `${pct(picked)}%` }} />
        <span className="seg notout" style={{ width: `${pct(notOut)}%` }} />
      </div>
      <div className="progress-legend">
        <span>
          <i className="dot picked" /> {picked} picked up
        </span>
        <span>
          <i className="dot notout" /> {notOut} not out
        </span>
        <span>
          <i className="dot pending" /> {total - done} left
        </span>
      </div>
    </div>
  );
}
