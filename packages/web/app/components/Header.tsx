import { Link } from "react-router";
import { UserButton } from "@hexclave/react";
import { getDevUser, hexclaveConfigured, setDevUser } from "../lib/auth";

/**
 * App header. In Hexclave mode the account surface is Hexclave's drop-in
 * <UserButton /> (themed via HexclaveTheme); in offline dev mode a plain
 * identity switcher stands in so the two-user demo works locally.
 */
export function Header({ crumb }: { crumb?: React.ReactNode }) {
  return (
    <header className="app-header">
      <Link to="/" className="brand">
        re<em>con</em>
      </Link>
      {crumb}
      <span className="spacer" />
      {hexclaveConfigured ? <UserButton /> : <DevUserSwitcher />}
    </header>
  );
}

function DevUserSwitcher() {
  const user = getDevUser();
  return (
    <button
      className="small"
      title="Dev mode: click to switch identity"
      onClick={() => {
        const name = window.prompt("Dev identity name:", user.name);
        if (!name) return;
        setDevUser({ id: `u_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name });
        window.location.reload();
      }}
    >
      {user.name} <span className="muted">(dev)</span>
    </button>
  );
}
