import { ConnectionsManager } from "@/components/settings/connections/connections-manager";

export default function ConnectionsPage() {
    return (
        <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-5 p-4 py-6 sm:p-6">
            <ConnectionsManager />
        </main>
    );
}
