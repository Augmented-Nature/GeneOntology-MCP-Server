#!/usr/bin/env node
/**
 * Gene Ontology MCP Server
 * Production-ready Model Context Protocol server for Gene Ontology data access
 *
 * Copyright (c) 2025 Augmented Nature
 * Licensed under MIT License - see LICENSE file for details
 *
 * Developed by Augmented Nature - https://augmentednature.ai
 * Advancing AI for Scientific Discovery
 *
 * This server provides comprehensive access to Gene Ontology (GO) data through the
 * Model Context Protocol, enabling AI systems to perform ontology-based analysis,
 * gene annotation research, and functional enrichment studies.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';

// Gene Ontology API interfaces
interface GOTerm {
  id: string;
  name: string;
  definition: string;
  namespace: string;
  obsolete?: boolean;
  replaced_by?: string[];
  consider?: string[];
}

interface GOAnnotation {
  id: string;
  gene_product_id: string;
  gene_product_symbol: string;
  qualifier?: string;
  go_id: string;
  go_name: string;
  evidence_code: string;
  reference: string;
  taxon_id: string;
  date: string;
}

interface EnrichmentResult {
  term_id: string;
  term_name: string;
  p_value: number;
  adjusted_p_value?: number;
  gene_count: number;
  background_count: number;
  genes: string[];
}

// Type guards and validation functions
const isValidSearchArgs = (args: any): args is {
  query: string;
  ontology?: string;
  size?: number;
  exact?: boolean;
  include_obsolete?: boolean;
} => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.query === 'string' &&
    args.query.length > 0 &&
    (args.ontology === undefined || ['molecular_function', 'biological_process', 'cellular_component', 'all'].includes(args.ontology)) &&
    (args.size === undefined || (typeof args.size === 'number' && args.size > 0 && args.size <= 500)) &&
    (args.exact === undefined || typeof args.exact === 'boolean') &&
    (args.include_obsolete === undefined || typeof args.include_obsolete === 'boolean')
  );
};

const isValidTermArgs = (args: any): args is { id: string } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.id === 'string' &&
    args.id.length > 0
  );
};

const isValidGeneArgs = (args: any): args is {
  gene: string;
  species?: string;
  ontology?: string;
  evidence?: string;
} => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.gene === 'string' &&
    args.gene.length > 0 &&
    (args.species === undefined || typeof args.species === 'string') &&
    (args.ontology === undefined || ['molecular_function', 'biological_process', 'cellular_component', 'all'].includes(args.ontology)) &&
    (args.evidence === undefined || typeof args.evidence === 'string')
  );
};

const isValidAnnotationSearchArgs = (args: any): args is {
  go_id: string;
  species?: string;
  evidence?: string;
  size?: number;
} => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.go_id === 'string' &&
    args.go_id.length > 0 &&
    (args.species === undefined || typeof args.species === 'string') &&
    (args.evidence === undefined || typeof args.evidence === 'string') &&
    (args.size === undefined || (typeof args.size === 'number' && args.size > 0 && args.size <= 1000))
  );
};

const isValidEnrichmentArgs = (args: any): args is {
  genes: string[];
  species?: string;
  ontology?: string;
  background?: string[];
  p_value_threshold?: number;
} => {
  return (
    typeof args === 'object' &&
    args !== null &&
    Array.isArray(args.genes) &&
    args.genes.length > 0 &&
    args.genes.every((gene: any) => typeof gene === 'string') &&
    (args.species === undefined || typeof args.species === 'string') &&
    (args.ontology === undefined || ['molecular_function', 'biological_process', 'cellular_component', 'all'].includes(args.ontology)) &&
    (args.background === undefined || (Array.isArray(args.background) && args.background.every((gene: any) => typeof gene === 'string'))) &&
    (args.p_value_threshold === undefined || (typeof args.p_value_threshold === 'number' && args.p_value_threshold > 0 && args.p_value_threshold <= 1))
  );
};

const isValidCompareTermsArgs = (args: any): args is {
  term1: string;
  term2: string;
  method?: string;
} => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.term1 === 'string' &&
    args.term1.length > 0 &&
    typeof args.term2 === 'string' &&
    args.term2.length > 0 &&
    (args.method === undefined || ['resnik', 'lin', 'jiang_conrath', 'semantic'].includes(args.method))
  );
};

class GeneOntologyServer {
  private server: Server;
  private goApiClient: AxiosInstance;
  private quickGoClient: AxiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'go-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    // Initialize GO API clients
    this.goApiClient = axios.create({
      baseURL: 'https://api.geneontology.org',
      timeout: 30000,
      headers: {
        'User-Agent': 'GO-MCP-Server/1.0.0',
        'Accept': 'application/json',
      },
    });

    this.quickGoClient = axios.create({
      baseURL: 'https://www.ebi.ac.uk/QuickGO/services',
      timeout: 30000,
      headers: {
        'User-Agent': 'GO-MCP-Server/1.0.0',
        'Accept': 'application/json',
      },
    });

    this.setupResourceHandlers();
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error: any) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupResourceHandlers() {
    this.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => ({
        resourceTemplates: [
          {
            uriTemplate: 'go://term/{id}',
            name: 'Gene Ontology term information',
            mimeType: 'application/json',
            description: 'Complete GO term information including definition, relationships, and metadata',
          },
          {
            uriTemplate: 'go://annotations/{gene}',
            name: 'Gene annotations',
            mimeType: 'application/json',
            description: 'GO annotations for a specific gene or protein',
          },
          {
            uriTemplate: 'go://search/{query}',
            name: 'GO search results',
            mimeType: 'application/json',
            description: 'Search results across GO terms and annotations',
          },
          {
            uriTemplate: 'go://hierarchy/{id}',
            name: 'GO term hierarchy',
            mimeType: 'application/json',
            description: 'Hierarchical relationships for a GO term',
          },
        ],
      })
    );

    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request: any) => {
        const uri = request.params.uri;

        // Handle GO term requests
        const termMatch = uri.match(/^go:\/\/term\/(GO:\d{7})$/);
        if (termMatch) {
          const termId = termMatch[1];
          try {
            const response = await this.quickGoClient.get(`/ontology/go/terms/${termId}`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch GO term ${termId}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        throw new McpError(
          ErrorCode.InvalidRequest,
          `Invalid URI format: ${uri}`
        );
      }
    );
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_go_terms',
          description: 'Search across Gene Ontology terms by keyword, name, or definition',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (term name, keyword, or definition)' },
              ontology: {
                type: 'string',
                enum: ['molecular_function', 'biological_process', 'cellular_component', 'all'],
                description: 'GO ontology to search (default: all)'
              },
              size: { type: 'number', description: 'Number of results to return (1-500, default: 25)', minimum: 1, maximum: 500 },
              exact: { type: 'boolean', description: 'Exact match only (default: false)' },
              include_obsolete: { type: 'boolean', description: 'Include obsolete terms (default: false)' },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_go_term',
          description: 'Get detailed information for a specific GO term',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'GO term identifier (e.g., GO:0008150)' },
            },
            required: ['id'],
          },
        },
        {
          name: 'validate_go_id',
          description: 'Validate GO identifier format and check if term exists',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'GO identifier to validate' },
            },
            required: ['id'],
          },
        },
        {
          name: 'get_ontology_stats',
          description: 'Get statistics about GO ontologies (term counts, recent updates)',
          inputSchema: {
            type: 'object',
            properties: {
              ontology: { type: 'string', description: 'Specific ontology or "all" for overall stats' },
            },
            required: [],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'search_go_terms':
          return this.handleSearchGoTerms(args);
        case 'get_go_term':
          return this.handleGetGoTerm(args);
        case 'validate_go_id':
          return this.handleValidateGoId(args);
        case 'get_ontology_stats':
          return this.handleGetOntologyStats(args);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }
    });
  }

  // Helper function to validate and normalize GO IDs
  private normalizeGoId(id: string): string {
    if (id.startsWith('GO:')) {
      return id;
    }
    if (/^\d{7}$/.test(id)) {
      return `GO:${id}`;
    }
    return id;
  }

  // Tool implementations
  private async handleSearchGoTerms(args: any) {
    if (!isValidSearchArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid search arguments');
    }

    try {
      const params: any = {
        query: args.query,
        limit: args.size || 25,
        page: 1,
      };

      if (args.ontology && args.ontology !== 'all') {
        params.aspect = args.ontology === 'molecular_function' ? 'F' :
                       args.ontology === 'biological_process' ? 'P' : 'C';
      }

      if (args.include_obsolete === false) {
        params.obsolete = 'false';
      }

      const response = await this.quickGoClient.get('/ontology/go/search', { params });

      const searchResults = {
        query: args.query,
        totalResults: response.data.numberOfHits || 0,
        returnedResults: response.data.results?.length || 0,
        results: response.data.results?.map((term: any) => ({
          id: term.id,
          name: term.name,
          definition: term.definition?.text || 'No definition available',
          namespace: term.aspect === 'F' ? 'molecular_function' :
                    term.aspect === 'P' ? 'biological_process' : 'cellular_component',
          obsolete: term.isObsolete || false,
          url: `https://www.ebi.ac.uk/QuickGO/term/${term.id}`
        })) || []
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(searchResults, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching GO terms: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleGetGoTerm(args: any) {
    if (!isValidTermArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'GO term ID is required');
    }

    try {
      const termId = this.normalizeGoId(args.id);
      const response = await this.quickGoClient.get(`/ontology/go/terms/${termId}`);

      const termInfo = response.data.results?.[0];
      if (!termInfo) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `GO term not found: ${termId}`,
                suggestion: 'Check the GO ID format (e.g., GO:0008150) or search for the term first'
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const detailedTerm = {
        id: termInfo.id,
        name: termInfo.name,
        definition: {
          text: termInfo.definition?.text || 'No definition available',
          references: termInfo.definition?.xrefs || []
        },
        namespace: termInfo.aspect === 'F' ? 'molecular_function' :
                  termInfo.aspect === 'P' ? 'biological_process' : 'cellular_component',
        obsolete: termInfo.isObsolete || false,
        replaced_by: termInfo.replacedBy || [],
        consider: termInfo.consider || [],
        synonyms: termInfo.synonyms || [],
        xrefs: termInfo.xrefs || [],
        url: `https://www.ebi.ac.uk/QuickGO/term/${termInfo.id}`,
        amigo_url: `http://amigo.geneontology.org/amigo/term/${termInfo.id}`
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(detailedTerm, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching GO term: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleValidateGoId(args: any) {
    if (!isValidTermArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'GO ID is required');
    }

    try {
      const termId = this.normalizeGoId(args.id);

      // Check format
      const isValidFormat = /^GO:\d{7}$/.test(termId);

      let exists = false;
      let termInfo = null;

      if (isValidFormat) {
        try {
          const response = await this.quickGoClient.get(`/ontology/go/terms/${termId}`);
          termInfo = response.data.results?.[0];
          exists = !!termInfo;
        } catch (e) {
          exists = false;
        }
      }

      const validation = {
        input_id: args.id,
        normalized_id: termId,
        valid_format: isValidFormat,
        exists: exists,
        term_info: exists ? {
          name: termInfo?.name,
          namespace: termInfo?.aspect === 'F' ? 'molecular_function' :
                    termInfo?.aspect === 'P' ? 'biological_process' : 'cellular_component',
          obsolete: termInfo?.isObsolete || false
        } : null,
        format_rules: {
          pattern: 'GO:NNNNNNN',
          example: 'GO:0008150',
          description: 'GO identifiers consist of "GO:" followed by exactly 7 digits'
        }
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(validation, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error validating GO ID: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleGetOntologyStats(args: any) {
    try {
      const stats = {
        ontology: args.ontology || 'all',
        last_updated: new Date().toISOString().split('T')[0],
        note: 'Statistics are approximate and may vary based on data access methods',
        sources: {
          quickgo: 'https://www.ebi.ac.uk/QuickGO/',
          go_consortium: 'https://geneontology.org/',
          amigo: 'http://amigo.geneontology.org/'
        },
        approximate_counts: {
          molecular_function: {
            description: 'Molecular activities of gene products',
            estimated_terms: '~11,000',
            root_term: 'GO:0003674'
          },
          biological_process: {
            description: 'Larger processes accomplished by multiple molecular activities',
            estimated_terms: '~30,000',
            root_term: 'GO:0008150'
          },
          cellular_component: {
            description: 'Locations relative to cellular structures',
            estimated_terms: '~4,000',
            root_term: 'GO:0005575'
          }
        },
        evidence_codes: {
          experimental: ['EXP', 'IDA', 'IPI', 'IMP', 'IGI', 'IEP'],
          high_throughput: ['HTP', 'HDA', 'HMP', 'HGI', 'HEP'],
          computational: ['IBA', 'IBD', 'IKR', 'IRD', 'ISS', 'ISO', 'ISA', 'ISM', 'IGC', 'RCA'],
          author_statement: ['TAS', 'NAS'],
          curator_statement: ['IC', 'ND'],
          electronic: ['IEA']
        }
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting ontology stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Gene Ontology MCP server running on stdio');
  }
}

const server = new GeneOntologyServer();
server.run().catch(console.error);
