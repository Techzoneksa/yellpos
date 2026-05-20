// Hook for admin user management (backend-wired).
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@/lib/use-server-fn";
import {
  listUsers, createUser, updateUser, resetCredentials, setUserActive, deleteUser,
  type UserDTO, type AppRole,
} from "./user-mgmt.functions";

export type { UserDTO, AppRole };

export function useAdminUsers() {
  const _list = useServerFn(listUsers);
  const _create = useServerFn(createUser);
  const _update = useServerFn(updateUser);
  const _reset = useServerFn(resetCredentials);
  const _setActive = useServerFn(setUserActive);
  const _del = useServerFn(deleteUser);

  const [users, setUsers] = useState<UserDTO[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows: any = await _list();
      setUsers(rows as UserDTO[]);
    } catch {
      // silent — manager screens already toast separately
    } finally {
      setLoading(false);
    }
  }, [_list]);

  useEffect(() => { reload(); }, [reload]);

  return {
    users, loading, reload,
    createUser: async (input: { fullName: string; username: string; role: AppRole; email?: string | null; password: string; active?: boolean; }) => {
      await _create({ data: input }); await reload();
    },
    updateUser: async (input: { id: string; fullName: string; username: string; role: AppRole; email?: string | null; active: boolean; }) => {
      await _update({ data: input }); await reload();
    },
    resetCredentials: async (id: string, password: string) => {
      await _reset({ data: { id, password } }); await reload();
    },
    setActive: async (id: string, active: boolean) => {
      await _setActive({ data: { id, active } }); await reload();
    },
    deleteUser: async (id: string) => {
      await _del({ data: { id } }); await reload();
    },
  };
}
