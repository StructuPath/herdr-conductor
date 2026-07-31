#!/usr/bin/env python3
"""Descriptor-held filesystem control plane for the isolated Stage 2 live harness."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import signal
import stat
import sys
import tempfile
from pathlib import Path

MAX_MANIFEST_BYTES = 16 * 1024 * 1024


def canonical(value):
    return (
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, indent=2, separators=(",", ": ")
        )
        + "\n"
    ).encode()


def identity(st):
    kind = (
        "directory"
        if stat.S_ISDIR(st.st_mode)
        else "file"
        if stat.S_ISREG(st.st_mode)
        else "other"
    )
    return {
        "type": kind,
        "device": str(st.st_dev),
        "inode": str(st.st_ino),
        "owner": str(st.st_uid),
        "mode": format(stat.S_IMODE(st.st_mode), "04o"),
    }


def same_identity(st, expected, sealed_manifest=False):
    observed = identity(st)
    wanted = {
        key: expected[key] for key in ("type", "device", "inode", "owner", "mode")
    }
    if sealed_manifest:
        wanted["mode"] = "0400"
    return observed == wanted


def read_all(fd, limit=MAX_MANIFEST_BYTES):
    chunks = []
    offset = 0
    while True:
        chunk = os.pread(fd, min(65536, limit + 1 - offset), offset)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        offset += len(chunk)
        if offset > limit:
            raise RuntimeError("descriptor content exceeds bound")


def descriptor_tree(fd, prefix="."):
    records = []
    try:
        for name in sorted(os.listdir(fd)):
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(st.st_mode) or not (
                stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)
            ):
                raise RuntimeError(f"unsupported inventory entry: {prefix}/{name}")
            path = name if prefix == "." else f"{prefix}/{name}"
            record = {"path": path, **identity(st)}
            if stat.S_ISREG(st.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if not same_identity(os.fstat(child), record):
                        raise RuntimeError(f"inventory identity changed: {path}")
                    record["sha256"] = hashlib.sha256(read_all(child)).hexdigest()
                finally:
                    os.close(child)
            else:
                child = os.open(
                    name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
                )
                try:
                    records.extend(descriptor_tree(child, path))
                finally:
                    os.close(child)
            records.append(record)
    except OSError as exc:
        raise RuntimeError(f"cannot inventory descriptor tree at {prefix}") from exc
    return records


def inventory_digest(records):
    return hashlib.sha256(canonical(records)).hexdigest()


class Control:
    def __init__(self, parent):
        parent = os.path.realpath(parent)
        self.parent_path = parent
        self.parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.parent_stat = os.fstat(self.parent_fd)
        name = os.path.basename(
            tempfile.mkdtemp(prefix="herdr-conductor-stage2-", dir=parent)
        )
        self.root_name = name
        self.root_path = os.path.join(parent, name)
        os.chmod(self.root_path, 0o700)
        try:
            self.root_fd = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=self.parent_fd,
            )
        except OSError as exc:
            raise RuntimeError("cannot open disposable root descriptor") from exc
        try:
            for child_name in ("control", "repositories", "state", "workspaces"):
                os.mkdir(child_name, 0o700, dir_fd=self.root_fd)
            self.control_fd = os.open(
                "control",
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=self.root_fd,
            )
            self.manifest_fd = os.open(
                "manifest.log",
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=self.control_fd,
            )
            self.marker_fd = os.open(
                "marker.json",
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=self.control_fd,
            )
        except OSError as exc:
            raise RuntimeError("cannot create disposable control tree") from exc
        self.nonce = secrets.token_hex(16)
        self.records = []
        self.sealed = False
        self.seal_bytes = None
        self.restored_directories = set()
        self.kill_at = None
        self.marker_bytes = canonical(
            {
                "document_type": "herdr-conductor-stage2-harness-marker",
                "schema_version": 1,
                "harness_nonce": self.nonce,
                "root": {"path": self.root_path, **identity(os.fstat(self.root_fd))},
                "parent": {"path": parent, **identity(self.parent_stat)},
                "manifest": identity(os.fstat(self.manifest_fd)),
            }
        )
        os.write(self.marker_fd, self.marker_bytes)
        os.fsync(self.marker_fd)
        for path, fd in [
            (".", self.root_fd),
            ("control", self.control_fd),
            ("control/manifest.log", self.manifest_fd),
            ("control/marker.json", self.marker_fd),
        ]:
            self.append(path, os.fstat(fd))
        for path in ("repositories", "state", "workspaces"):
            fd = os.open(
                path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.root_fd
            )
            try:
                self.append(path, os.fstat(fd))
            finally:
                os.close(fd)

    def checkpoint(self, name):
        if self.kill_at == name:
            os.kill(os.getpid(), signal.SIGKILL)

    def append_bytes(self, record):
        encoded = canonical(record)
        framed = f"{len(encoded)}\n".encode() + encoded
        os.lseek(self.manifest_fd, 0, os.SEEK_END)
        os.write(self.manifest_fd, framed)
        os.fsync(self.manifest_fd)
        self.records.append(record)
        return record

    def append(self, path, st=None, workspace=None):
        if self.sealed:
            raise RuntimeError("manifest is sealed")
        if path.startswith("/") or ".." in Path(path).parts:
            raise RuntimeError("manifest path escapes root")
        if st is None:
            parent_fd, name = self.open_record_parent(path)
            try:
                st = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            finally:
                if parent_fd != self.root_fd:
                    os.close(parent_fd)
            if stat.S_ISLNK(st.st_mode):
                raise RuntimeError("manifest path is a symlink")
        return self.append_bytes(
            {
                "record_type": "resource",
                "harness_nonce": self.nonce,
                "sequence": len(self.records) + 1,
                "path": path,
                **identity(st),
                "workspace": workspace,
            }
        )

    def append_workspace(self, workspace_id):
        if self.sealed:
            raise RuntimeError("manifest is sealed")
        if (
            not isinstance(workspace_id, str)
            or not workspace_id
            or len(workspace_id) > 128
        ):
            raise RuntimeError("invalid external workspace identity")
        if any(
            record.get("record_type") == "external_workspace"
            and record.get("workspace_id") == workspace_id
            for record in self.records
        ):
            raise RuntimeError("duplicate external workspace identity")
        return self.append_bytes(
            {
                "record_type": "external_workspace",
                "harness_nonce": self.nonce,
                "sequence": len(self.records) + 1,
                "workspace_id": workspace_id,
            }
        )

    def record_disposable_tree(self):
        if self.sealed:
            raise RuntimeError("manifest is sealed")
        listed = {
            record["path"]: record
            for record in self.records
            if record["record_type"] == "resource"
        }
        for path, record in listed.items():
            self.verify_entry(record)
        added = []
        for observed in descriptor_tree(self.root_fd):
            path = observed["path"]
            if path in listed:
                continue
            parent_fd, name = self.open_record_parent(path)
            try:
                added.append(
                    self.append(
                        path, os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                    )
                )
            finally:
                if parent_fd != self.root_fd:
                    os.close(parent_fd)
        return {"added_count": len(added)}

    def output_intent(self, data):
        if self.sealed:
            raise RuntimeError("manifest is sealed")
        required = {
            "logical_id",
            "parent_path",
            "parent_device",
            "parent_inode",
            "filename",
            "logical_sequence",
        }
        if set(data) != required:
            raise RuntimeError("invalid output intent")
        expected = [
            ("source_manifest", 1),
            ("human_report", 2),
            ("machine_evidence", 3),
        ]
        logical = (data["logical_id"], data["logical_sequence"])
        if (
            logical
            != expected[
                len(
                    [
                        r
                        for r in self.records
                        if r["record_type"] == "external_output.intent"
                    ]
                )
            ]
        ):
            raise RuntimeError("output intent order differs")
        return self.append_bytes(
            {
                "record_type": "external_output.intent",
                "harness_nonce": self.nonce,
                "global_sequence": len(self.records) + 1,
                **data,
            }
        )

    def seal(self):
        if self.sealed:
            return self.seal_record
        if len(
            [r for r in self.records if r["record_type"] == "external_output.intent"]
        ) not in (0, 3):
            raise RuntimeError("output intent set is incomplete")
        prior = read_all(self.manifest_fd)
        seal = {
            "record_type": "seal",
            "harness_nonce": self.nonce,
            "sequence": len(self.records) + 1,
            "record_count": len(self.records),
            "preceding_byte_count": len(prior),
            "preceding_sha256": hashlib.sha256(prior).hexdigest(),
        }
        self.append_bytes(seal)
        os.fchmod(self.manifest_fd, 0o400)
        os.fsync(self.manifest_fd)
        os.fsync(self.control_fd)
        self.seal_bytes = read_all(self.manifest_fd)
        self.seal_record = seal
        self.sealed = True
        self.verify_control()
        return seal

    def verify_control(self):
        if read_all(self.marker_fd) != self.marker_bytes:
            raise RuntimeError("marker bytes changed")
        if self.sealed and read_all(self.manifest_fd) != self.seal_bytes:
            raise RuntimeError("sealed manifest bytes changed")
        if not same_identity(os.fstat(self.root_fd), self.records[0]):
            raise RuntimeError("root descriptor identity changed")
        if not same_identity(os.fstat(self.control_fd), self.records[1]):
            raise RuntimeError("control descriptor identity changed")
        if not same_identity(os.fstat(self.marker_fd), self.records[3]):
            raise RuntimeError("marker descriptor identity changed")
        if not same_identity(os.fstat(self.manifest_fd), self.records[2], self.sealed):
            raise RuntimeError("manifest descriptor identity changed")

    def open_record_parent(self, path):
        parts = Path(path).parts
        if path == ".":
            return self.parent_fd, self.root_name
        fd = self.root_fd
        for part in parts[:-1]:
            next_fd = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=fd,
            )
            if fd != self.root_fd:
                os.close(fd)
            fd = next_fd
        return fd, parts[-1]

    def verify_entry(self, record):
        if record["path"] == ".":
            st = os.fstat(self.root_fd)
        else:
            parent_fd, name = self.open_record_parent(record["path"])
            try:
                st = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            finally:
                if parent_fd != self.root_fd:
                    os.close(parent_fd)
        expected = record
        if record["path"] in self.restored_directories:
            expected = {**record, "mode": "0700"}
        if not same_identity(
            st,
            expected,
            self.sealed and record["path"] == "control/manifest.log",
        ):
            raise RuntimeError(f"identity changed: {record['path']}")

    def restore_directory_permissions(self, record):
        self.verify_control()
        self.verify_entry(record)
        parent_fd, name = self.open_record_parent(record["path"])
        descriptor = None
        try:
            descriptor = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=parent_fd,
            )
            if not same_identity(os.fstat(descriptor), record):
                raise RuntimeError(
                    f"permission restoration identity changed: {record['path']}"
                )
            os.fchmod(descriptor, 0o700)
            os.fsync(descriptor)
            self.restored_directories.add(record["path"])
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if parent_fd not in (self.root_fd, self.parent_fd):
                os.close(parent_fd)

    def delete_record(self, record):
        self.verify_control()
        self.verify_entry(record)
        parent_fd, name = self.open_record_parent(record["path"])
        try:
            if record["type"] == "directory":
                os.rmdir(name, dir_fd=parent_fd)
            else:
                os.unlink(name, dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            if parent_fd not in (self.root_fd, self.parent_fd):
                os.close(parent_fd)

    def teardown(self, kill_at=None):
        if not self.sealed:
            raise RuntimeError("manifest is not sealed")
        self.kill_at = kill_at
        resources = [r for r in self.records if r["record_type"] == "resource"]
        listed = {r["path"] for r in resources}
        actual = {".", *(record["path"] for record in descriptor_tree(self.root_fd))}
        if actual != listed:
            raise RuntimeError("unlisted or missing disposable entry")
        for record in resources:
            self.verify_entry(record)
        ordinary = [
            r
            for r in resources
            if r["path"]
            not in {".", "control", "control/marker.json", "control/manifest.log"}
        ]
        ordinary.sort(
            key=lambda r: (r["path"].count("/"), len(r["path"])), reverse=True
        )
        for record in ordinary:
            if record["type"] == "directory" and record["mode"] != "0700":
                self.checkpoint(f"before_permission_restore:{record['path']}")
                self.restore_directory_permissions(record)
                self.checkpoint(f"after_permission_restore:{record['path']}")
        for record in ordinary:
            self.checkpoint(f"before_remove:{record['path']}")
            self.delete_record(record)
            self.checkpoint(f"after_remove:{record['path']}")
        try:
            self.verify_control()
            self.checkpoint("before_marker_unlink")
            os.unlink("marker.json", dir_fd=self.control_fd)
            os.fsync(self.control_fd)
            self.checkpoint("after_marker_unlink")
            self.verify_control()
            self.checkpoint("before_manifest_unlink")
            os.unlink("manifest.log", dir_fd=self.control_fd)
            os.fsync(self.control_fd)
            self.checkpoint("after_manifest_unlink")
            self.verify_control()
            self.checkpoint("before_control_remove")
            os.rmdir("control", dir_fd=self.root_fd)
            os.fsync(self.root_fd)
            self.checkpoint("after_control_remove")
            self.verify_control()
            if os.listdir(self.root_fd):
                raise RuntimeError("disposable root not empty")
            if not same_identity(os.fstat(self.parent_fd), identity(self.parent_stat)):
                raise RuntimeError("harness parent identity changed")
            root_st = os.stat(
                self.root_name, dir_fd=self.parent_fd, follow_symlinks=False
            )
            if not same_identity(root_st, resources[0]):
                raise RuntimeError("root name identity changed")
            self.checkpoint("before_root_remove")
            os.rmdir(self.root_name, dir_fd=self.parent_fd)
            os.fsync(self.parent_fd)
            self.checkpoint("after_root_remove")
            try:
                os.stat(self.root_name, dir_fd=self.parent_fd, follow_symlinks=False)
                raise RuntimeError("disposable root still exists")
            except FileNotFoundError:
                pass
        except OSError as exc:
            raise RuntimeError("descriptor-held teardown failed") from exc
        return {
            "status": "passed",
            "root_absent": True,
            "state_absent": True,
            "out_of_root_deletion_count": 0,
            "unlisted_residue_count": 0,
        }


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "serve":
        raise SystemExit("usage: harness-fs-helper.py serve <os-temp-parent>")
    control = Control(sys.argv[2])
    print(
        json.dumps(
            {
                "ok": True,
                "root_path": control.root_path,
                "nonce": control.nonce,
                "helper_pid": os.getpid(),
                **identity(os.fstat(control.root_fd)),
            }
        ),
        flush=True,
    )
    for line in sys.stdin:
        try:
            request = json.loads(line)
            command = request.pop("command")
            if command == "append":
                result = control.append(
                    request["path"], workspace=request.get("workspace")
                )
            elif command == "append_workspace":
                result = control.append_workspace(request["workspace_id"])
            elif command == "record_tree":
                result = control.record_disposable_tree()
            elif command == "output_intent":
                result = control.output_intent(request)
            elif command == "seal":
                result = control.seal()
            elif command == "teardown":
                result = control.teardown(request.get("kill_at"))
            elif command == "stop":
                result = {"stopped": True}
                print(json.dumps({"ok": True, "result": result}), flush=True)
                break
            else:
                raise RuntimeError("unknown helper command")
            print(json.dumps({"ok": True, "result": result}), flush=True)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
