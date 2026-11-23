import type { EtlRunDownloadSource } from "../../storage/mysql";
/** A source the ETL pipeline runs, with the name to show for it. */
export interface EtlSourceLabel {
    /** The ETL source label — the same key the run stage tables use. */
    readonly key: EtlRunDownloadSource;
    /** The name to show an operator. */
    readonly label: string;
    /**
     * True when the source's contribution is recorded on the `etl_runs`
     * row itself. The DB-IP files share one lumped counter; the rest are
     * counted per file in the stage tables.
     */
    readonly hasRunCounter: boolean;
}
/**
 * The sources the ETL pipeline runs.
 *
 * The list is the pipeline's own table, imported from pipeline.ts.
 * pipeline.ts does not import this module, so there is no cycle.
 */
export declare const ETL_SOURCE_LABELS: Readonly<Record<EtlRunDownloadSource, EtlSourceLabel>>;
/**
 * The source list, in the order the pipeline runs them — which is the
 * order the files are fetched and the rows are filled, so it is also
 * the priority order.
 */
export declare function etlSourceLabels(): EtlSourceLabel[];
/**
 * The labels as a plain object, for a caller that wants to look a
 * source up rather than list them.
 */
export declare function etlSourceLabelMap(): Record<string, string>;
/**
 * How many distinct upstreams the pipeline draws from.
 *
 * The pipeline fetches seven files, but those files come from four
 * places: DB-IP (three files), metowolf/iplist, runishiwo/ChinaIPlist
 * (two files) and sapics/ip-location-db. A page that says "N data
 * sources" means upstreams, not files — "seven data sources" would
 * read as seven independent providers, which is not what a second file
 * from the same repository is.
 *
 * Derived from the label table so it cannot drift from the pipeline
 * the way a hand-written number does.
 */
export declare function etlUpstreamCount(): number;
