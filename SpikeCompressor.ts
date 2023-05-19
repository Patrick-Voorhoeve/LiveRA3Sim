import fs               from 'fs';
import path             from 'path';
import { parse }        from 'csv-parse';
import { plot, Plot }   from 'nodeplotlib';
import * as m           from 'mathjs';
import { channel }      from 'diagnostics_channel';


type Welfords           = { mean: number , sumSquaredDiff: number };

// ONLY USE THIS FOR TESTING
const rawBuffer         = Array.from(Array(32).keys()).map(ch => [] as number[]);

class SpikeCompressor {
    
    prevRowRaw          = null as number[] | null;
    prevRowFiltered     = null as number[] | null;

    count               = 1;

    plots               = [] as Plot[];

    // Initialisation and pre-processing constants
	NUM_CHANNELS 		= 32;
	SAMPLE_RATE 		= 30000;
    CUTOFF_FREQ         = 300;
    
    // Spike buffer constants
    MAX_BUFFER_LENGTH   = 1024;	
    SPIKE_LENGTH        = 22;                                                   // Length of a spike from the crossing

    // Peak detection constants
    AFTER_CROSS         = 0;                                                    // The crossing of the second threshold must happen between AFTER_CROSS and BEFORE_PEAK
    BEFORE_PEAK         = 5;                                                    // samples after the first crossing    
    MIN_THRESHOLD1      = 23;
    MIN_THRESHOLD2      = 60;

    // Compression constants
    SPIKE_BUFFER_LENGTH = 100;                                                  // Number of spikes to add to the "spike" array (of a channel) before compressing the buffer    

    emptyChannels       = Array.from(Array(this.NUM_CHANNELS).keys());

    thresholds          = this.emptyChannels.map(ch => ({ mean: 0, sumSquaredDiff: 0 } as Welfords) );

    spikeBuffer         = this.emptyChannels.map(ch => [] as number[]);         // Stores the last SPIKE_LENGTH readings for use in the spike detection algorithm
    spikeCandidates     = this.emptyChannels.map(ch => [] as number[]);         // Channel array where each channel contains an array of potential spike start times
    spikesQueue         = this.emptyChannels.map(ch => [] as number[]);         // Holds the starting point of spikes who are waiting for the full SPIKE_LENGTH of data to be processed
    lastSpike           = this.emptyChannels.map(ch => 0);                      // Array that stores the end points of real spikes
    spikes              = this.emptyChannels.map(ch => [] as number[][]);       // An array of spike data for each channel
    spikeIndices        = this.emptyChannels.map(ch => [] as number[]);

    plot = () => {                    
        plot( this.plots );        
    }

	parseBuffer = async ( r: string[] ) => {        
        
        // Load and cast the current and previous rows
        const row               = r.map(v => parseFloat(v));        
        const prevFilt          = this.prevRowFiltered || row;
        const prevRaw           = this.prevRowRaw || row;
        const count             = this.count;

        // Apply a live filter 
        const RC                = 1 / (2 * Math.PI * this.CUTOFF_FREQ);
        const dt                = 1 / this.SAMPLE_RATE;
        const alpha             = RC / (RC + dt)    
        const filteredRow       = row.map(( _ , ch ) => alpha * (prevFilt[ch] + row[ch] - prevRaw[ch]))    

        
        filteredRow.forEach((value, chIdx) => {

            // Calculate the thesholds
            // ###############################################################################################
            // Calculates the thresholds for the threshold agorithm. These
            // are calculated based on the standard deviation of the signal.
            // As this is an "on-line" algorithm, Welfords standard deviation
            // algorithm is used to keep a running track of the standard deviation.

            // Use Welford's online algorithm to calculate the running standard deviation of the channel.            
            const S                 = this.thresholds[chIdx].sumSquaredDiff;           
            const M                 = this.thresholds[chIdx].mean;           
            const n                 = this.count;
            const x                 = value;

            // Calculate the new mean and sumSquaredDiff    
            const M2                = M + (x - M) / n;
            const S2                = S + (x - M) * (x - M2)            
            
            // Calculate the standard deviation and thresholds from the above values
            const std               = Math.sqrt(S2 / (n - 1));
            const threshold1        = Math.max(std * 0.9, this.MIN_THRESHOLD1);
            const threshold2        = Math.max(std * 2.2, this.MIN_THRESHOLD2);                        

            // Update the thresholds array with the new values  
            this.thresholds[chIdx].mean             = M2;
            this.thresholds[chIdx].sumSquaredDiff   = S2;                    

            // Detect Spikes Via Two Threshold System
            // ###############################################################################################
            // This two threshold system is used to detect spikes in a channel.
            // It works by defining two thresholds based on the standard deviation
            // of the signal. When a signal crosses the first threshold, it checks N
            // steps ahead to see if it also crosses the second threshold. It counts
            // any that do as a spike. The algorithm also makes sure that spikes
            // have a minimum amount of time before another spike can be detected.            

            // Append the channel value to the spikeBuffer. Use slice to ensure spikeBuffer always has a size of SPIKE_LENGTH
            this.spikeBuffer[chIdx]     = [ ...( this.spikeBuffer[chIdx].length >= this.SPIKE_LENGTH ? this.spikeBuffer[chIdx].slice(1) : this.spikeBuffer[chIdx] ), value ]            

            // If the spike buffer is not full then skip
            if(this.spikeBuffer[chIdx].length < this.SPIKE_LENGTH) return;

            // The value that we look at will be the FIRST value in the spike buffer (SPIKE_LENGTH samples away from real time)
            const val                   = this.spikeBuffer[chIdx][0];                        
            const absVal                = m.abs(val);

            // If the value crosses the first threshold
            if(absVal > threshold1) {

                // Determine the direction of the second threshold (is the spike going up or down)                                
                const threshold2Upper   = threshold2;
                const threshold2Lower   = threshold2 * -1;

                // Check to see if the value crosses the seconds threshold within BEFORE_PEAK points                
                for(let i = this.AFTER_CROSS; i <= this.BEFORE_PEAK; i++) {
                    const val2 = this.spikeBuffer[chIdx][i];

                    // If it crosses the second threshold a peak has been detected. 
                    // Push the spike to the spikes buffer.
                    // Empty this channels spike buffer so that no new spikes can be detected until AFTER this spike.
                    if( val > 0 ? val2 > threshold2Upper : val2 < threshold2Lower) {
                        const spikeData         = [...this.spikeBuffer[chIdx]];
                        const spikeIndex        = count - this.SPIKE_LENGTH;
                        this.spikeBuffer[chIdx] = [];

                        this.spikes[chIdx].push(spikeData);
                        this.spikeIndices[chIdx].push(spikeIndex);
                    }
                }
            }
            
        })
        // Train the PCA Algorithm to find principle components 
        // ###############################################################################################
        // The PCA algorithm requires a bunch of datapoints found using training data.
        // While training mode is active, this section will use the live data to calculate
        // the principle component coefficients needed for the compression algorithm.

        // Asume that we aready have the key values from runnings training data elsewhere. (I'm using the training data from the py script)         
        // In training data Qty_principle_components = 4.       
        const sampleMean                = 22;
        const compressedMean            = [-115.21631559, -20.40026275, -2.17209171, 0.88116711];
        const prinicpleCoeff            = [
            [ 0.22092193 ,0.11558138  ,-0.21872051 ,0.37172734   ],
            [ 0.30996979 ,0.15590247  ,-0.26609597 ,0.34530065   ],
            [ 0.33207249 ,0.16399986  ,-0.23350182 ,0.1798407    ],
            [ 0.34520316 ,0.15720681  ,-0.17618261 ,0.00708204   ],
            [ 0.33748027 ,0.13236452  ,-0.09906053 ,-0.13809233  ],
            [ 0.31999083 ,0.09622249  ,-0.02029416 ,-0.22862091  ],
            [ 0.29940146 ,0.0552858   ,0.05841917  ,-0.26879006  ],
            [ 0.27570837 ,0.01144066  ,0.14106933  ,-0.26928983  ],
            [ 0.24976398 ,-0.03503576 ,0.22421329  ,-0.22981739  ],
            [ 0.22309473 ,-0.0857638  ,0.29285845  ,-0.14309402  ],
            [ 0.19717888 ,-0.13959793 ,0.32705755  ,-0.01600818  ],
            [ 0.17181376 ,-0.19323624 ,0.31075467  ,0.12294715   ],
            [ 0.14671264 ,-0.24203982 ,0.24896777  ,0.22944826   ],
            [ 0.12279778 ,-0.27909411 ,0.1548717   ,0.27321599   ],
            [ 0.10111053 ,-0.30258439 ,0.0492714   ,0.25135961   ],
            [ 0.08204061 ,-0.31325844 ,-0.04798948 ,0.17961701   ],
            [ 0.06559903 ,-0.31458296 ,-0.13010998 ,0.08260568   ],
            [ 0.05129058 ,-0.30863557 ,-0.19506353 ,-0.02281793  ],
            [ 0.03849774 ,-0.29780081 ,-0.24144244 ,-0.11958309  ],
            [ 0.02737146 ,-0.28140923 ,-0.26782115 ,-0.19380861  ],
            [ 0.01843086 ,-0.26248544 ,-0.27446996 ,-0.24009034  ],
            [ 0.01076361 ,-0.24122548 ,-0.26766447 ,-0.25659321  ]
        ];
       

        // Using the above trained PCA components, compress the data
        // ###############################################################################################
        // This algorithm uses a set of training and testing data
        // It uses the training data to sample the mean and Eigenvalues 
        // and Eigenvectors. Using these values, the compression itself 
        // is very computationaly unintensive.                
        
        const spikeList = this.spikes;        

        spikeList.forEach(channel =>  {

            // Wait until at least SPIKE_BUFFER_LENGTH spikes have been detected for this channel
            if(channel.length < this.SPIKE_BUFFER_LENGTH) return;
            
            // Initialise the matrices
            const channelMatrix         = m.matrix(channel);
            const coeffMatrix           = m.matrix(prinicpleCoeff);
            const meanMatrix            = m.matrix(compressedMean);

            // Apply the compression maths
            const mult                  = m.multiply(channelMatrix, coeffMatrix);            
            const compressed            = m.subtract(mult, meanMatrix)                                    

            // Send the compressed data to the frontend

            this.spikes = this.emptyChannels.map(ch => [] as number[][]); 
        })
        
        
        // #######################################
        // TESTING ONLY
        const testIterations = 1000

        if(this.count <= testIterations) {
            rawBuffer.push(filteredRow);
        }
                
        if(this.count === testIterations) {
            const testChannel   = 0;
            const testSpikes    = this.spikes[testChannel];
            const testRaw       = rawBuffer.map(d => d[testChannel]);

            console.log(`\n\nChannel ${testChannel}:\nNumber of Detected Spikes: ${testSpikes.length}\nNumber of Data Points: ${testSpikes.length * this.SPIKE_LENGTH}\n\n`);
            
            // PLOT JUST A SINGLE CHANNEL AND THE RAW DATA
            // this.plots.push({y: testRaw, type: 'scatter'})            
            // this.plots.push({y: testSpikes.flat(), type: 'scatter'})            

            // PLOT EVERY CHANNEL AND EVERY SPIKE            
            for(const channel of this.spikes) for(const spike of channel) this.plots.push({y: spike, type: 'scatter'})                        

            // PLOT EVERY SPIKE OF A SINGLE CHANNEL
            // for(const spike of testSpikes) this.plots.push({y: spike, type: 'scatter'})                        

            this.plot()    
        };

        // ############################################

        this.prevRowRaw         = row;
        this.prevRowFiltered    = filteredRow;

        // Increment the current index in the data              
        this.count++;  
	}

	readData = async () => {

		// Create the path to the csv file containing the MEA data
		const DATA_PATH = path.join(__dirname, './data/MEA_recording_32ch_20s_30khz.csv');

        const readStreamSync = new Promise((resolve, reject) => {
            
            // Create a parser to read an N second segment of the data
            const parser            = parse({ 
                delimiter:              ',', 
                skip_empty_lines:       true
            });
            
            // Open a read stream with the data.
            const readable = fs.createReadStream(DATA_PATH);
            
            readable.pipe(parser)
            
            // For every row in the CSV file, push the row to the buffer
            .on("data", this.parseBuffer)

            // End and errors 
            .on('end', resolve)        
            .on('error', reject)
        })
        
        await readStreamSync;

        console.log("Finished reading the data stream");

    }
}


export default SpikeCompressor