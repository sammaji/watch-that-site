"use client";

import { useUpdateConnection } from "@/hooks/use-connections";
import { providerLabel } from "@/lib/connections/providers";
import type { ProviderConnection } from "@watchthatsite/types";
import { Button } from "@watchthatsite/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@watchthatsite/ui/components/dropdown-menu";
import { Switch } from "@watchthatsite/ui/components/switch";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@watchthatsite/ui/components/table";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@watchthatsite/ui/components/tooltip";
import { cn } from "@watchthatsite/ui/lib/utils";
import { Check, CircleDashed, MoreHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import { ProviderLogo } from "./provider-logo";

/**
 * The owner's own connections as a table: what each one is, how it is set
 * up, whether the model gateway can use its key, and its actions.
 */
export function ConnectionsTable({
    connections,
    onEdit,
    onEditModels,
    onDelete,
}: {
    connections: ProviderConnection[];
    onEdit: (connection: ProviderConnection) => void;
    onEditModels: (connection: ProviderConnection) => void;
    onDelete: (connection: ProviderConnection) => void;
}) {
    return (
        // The table scrolls sideways inside its border on a narrow screen;
        // the page itself never does.
        <div className="rounded-lg border">
            <Table className="min-w-[560px]">
                <TableHeader>
                    <TableRow className="hover:bg-transparent">
                        <TableHead className="w-10 pl-4">
                            <span className="sr-only">Status</span>
                        </TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>API key</TableHead>
                        <TableHead className="w-14">
                            <span className="sr-only">Enabled</span>
                        </TableHead>
                        <TableHead className="w-12 pr-4">
                            <span className="sr-only">Actions</span>
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {connections.map(connection => (
                        <ConnectionTableRow
                            key={connection.id}
                            connection={connection}
                            onEdit={() => onEdit(connection)}
                            onEditModels={() => onEditModels(connection)}
                            onDelete={() => onDelete(connection)}
                        />
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function ConnectionTableRow({
    connection,
    onEdit,
    onEditModels,
    onDelete,
}: {
    connection: ProviderConnection;
    onEdit: () => void;
    onEditModels: () => void;
    onDelete: () => void;
}) {
    const update = useUpdateConnection();
    const toggle = (enabled: boolean) =>
        update.mutate(
            { id: connection.id, enabled },
            { onError: err => toast.error(err.message) },
        );

    return (
        <TableRow>
            <TableCell className="w-10 pl-4">
                <StatusIcon connection={connection} />
            </TableCell>
            <TableCell
                className={cn(
                    "max-w-60",
                    !connection.enabled && "text-muted-foreground",
                )}>
                <span className="block truncate font-medium">
                    {connection.name}
                </span>
            </TableCell>
            <TableCell
                className={cn(!connection.enabled && "text-muted-foreground")}>
                <div className="flex items-center gap-2 whitespace-nowrap">
                    <ProviderLogo
                        kind={connection.kind}
                        baseUrl={connection.base_url}
                    />
                    {providerLabel(connection.kind, connection.base_url)}
                </div>
            </TableCell>
            <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                {connection.api_key_hint ?
                    `••••${connection.api_key_hint}`
                :   "••••"}
            </TableCell>
            <TableCell className="w-14">
                <Switch
                    checked={connection.enabled}
                    disabled={update.isPending}
                    onCheckedChange={toggle}
                    aria-label={`${connection.enabled ? "Disable" : "Enable"} ${connection.name}`}
                />
            </TableCell>
            <TableCell className="pr-4 text-right">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${connection.name}`}>
                            <MoreHorizontal />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={onEdit}>
                            Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={onEditModels}>
                            Models
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            onSelect={onDelete}>
                            Delete
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </TableCell>
        </TableRow>
    );
}

/**
 * Whether the model gateway can use the key: a check or a cross, with the
 * reason in a tooltip. The gateway lists models with every key when it is
 * added and again in the background; a failure carries the provider's own
 * message from that listing. The icon is a button so the tooltip also opens
 * from the keyboard.
 */
function StatusIcon({ connection }: { connection: ProviderConnection }) {
    const status = connection.status;
    const view =
        status?.state === "working" ?
            {
                icon: (
                    <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
                ),
                label: "Success",
                detail: "Success",
            }
        : status?.state === "failing" ?
            {
                icon: <X className="text-destructive size-4" />,
                label: "Failing",
                detail:
                    status.error ??
                    "The provider refused the key. Check it and the settings.",
            }
        :   {
                icon: <CircleDashed className="text-muted-foreground size-4" />,
                label: "Not checked yet",
                detail:
                    status ?
                        "The gateway has not checked this key yet."
                    :   "The gateway could not be asked about this key right now.",
            };
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    aria-label={
                        view.label === view.detail ?
                            view.label
                        :   `${view.label}: ${view.detail}`
                    }
                    className="focus-visible:ring-ring/50 inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-[3px]">
                    {view.icon}
                </button>
            </TooltipTrigger>
            <TooltipContent
                side="top"
                align="start"
                className="px-2 py-1 text-xs break-words">
                {status?.state === "failing" ?
                    <>
                        <span className="font-medium">Failing: </span>
                        {view.detail}
                    </>
                :   view.detail}
            </TooltipContent>
        </Tooltip>
    );
}
