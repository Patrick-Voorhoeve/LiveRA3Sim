import fs           from 'fs';
import path         from 'path';
import { parse }    from 'csv-parse';
import { highPass, std, timer }    from './utils';
import { plot, Plot } from 'nodeplotlib';

type Welfords           = { mean: number , sumSquaredDiff: number };

// ONLY USE THIS FOR TESTING
const rawBuffer         = Array.from(Array(32).keys()).map(ch => [] as number[]);

class SpikeCompressor {
    
    prevRowRaw          = null as number[] | null;
    prevRowFiltered     = null as number[] | null;

    count               = 1;

    plots               = [] as Plot[];

	NUM_CHANNELS 		= 32;
	SAMPLE_RATE 		= 30000;
    CUTOFF_FREQ         = 300;
    MAX_BUFFER_LENGTH   = 1024;	
    SPIKE_LENGTH        = 22;                                                   // Length of a spike from the crossing
    BEFORE_PEAK         = 3;                                                    // Maximum number of samples between the crossing and the peak that qualify as a spike
    MIN_SPIKE_GAP       = 5;                                                    // Minimum distance between the end of one spike and the start of a new spike
    
    emptyChannels       = Array.from(Array(this.NUM_CHANNELS).keys());

    thresholds          = this.emptyChannels.map(ch => ({ mean: 0, sumSquaredDiff: 0 } as Welfords) );

    spikeBuffer         = this.emptyChannels.map(ch => [] as number[]);         // Stores the last SPIKE_LENGTH readings for use in the spike detection algorithm
    spikeCandidates     = this.emptyChannels.map(ch => [] as number[]);  // Channel array where each channel contains an array of potential spike start times
    spikesQueue         = this.emptyChannels.map(ch => [] as number[]);         // Holds the starting point of spikes who are waiting for the full SPIKE_LENGTH of data to be processed
    lastSpike           = this.emptyChannels.map(ch => 0);                      // Array that stores the end points of real spikes
    spikes              = this.emptyChannels.map(ch => [] as number[][]);       // An array of spike data for each channel

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
            // Use Welford's online algorithm to calculate the running standard deviation of the channel.
            let { mean: M, sumSquaredDiff: S }   = this.thresholds[chIdx];            
            const n                              = this.count;
            const x                              = value;
            const absValue                       = Math.abs(value);

            // Calculate the new mean and sumSquaredDiff    
            const M2                = M + (x - M) / n;
            const S2                = S + (x - M) * (x - M2)            
            
            // Calculate the standard deviation and thresholds from the above values
            const std               = Math.sqrt(S2 / (n - 1));
            const threshold1        = std * 0.8;
            const threshold2        = std * 2.2;                        

            // Update the thresholds array with the new values  
            this.thresholds[chIdx].mean             = M2;
            this.thresholds[chIdx].sumSquaredDiff   = S2;                    

            // Append the channel value to the spikeBuffer. Use slice to ensure spikeBuffer always has a size of SPIKE_LENGTH
            this.spikeBuffer[chIdx]                 = [ ...( this.spikeBuffer[chIdx].length >= this.SPIKE_LENGTH ? this.spikeBuffer[chIdx].slice(1) : this.spikeBuffer[chIdx] ), value ]            

            // If the spike buffer is not filled or the thresholds are not stabilised then do not search for spikes
            if(this.spikeBuffer[chIdx].length < this.SPIKE_LENGTH) return;
            if(threshold1 < 20) return;
            
            const isAwayFromLastSpike      = count > this.lastSpike[chIdx] + this.MIN_SPIKE_GAP;
            const isAboveThreshold1        = absValue > threshold1 && absValue < threshold2;

            // If the value crosses the first threshold, create a spike candidate at count
            if( isAboveThreshold1 && isAwayFromLastSpike ) {
                this.spikeCandidates[chIdx].push(count);
            }

            this.spikeCandidates[chIdx].forEach((candidate) => {

                const isAboveThreshold2 = absValue > threshold2;
                const isNotItself       = count - candidate > 1;
                const isAfterBeforePeak = count - candidate < this.BEFORE_PEAK

                // If the value crosses the second threshold and there is an existing candidate within the range of BEFORE_PEAK, add a spike to the spikes queue
                if(candidate && isAboveThreshold2 && isAfterBeforePeak && isNotItself) {
        
                    this.spikesQueue[chIdx].push(candidate);
                    this.spikeCandidates[chIdx]  = [];
                }
            })
            
            // For every spike in the spike queue, 
            const newSpikesQueue = [] as number[];
            this.spikesQueue[chIdx].forEach((start) => {
                // Check if the current spike is within the lastSpikes + MIN_SPIKE_GAP range
                if(count < this.lastSpike[chIdx] + this.MIN_SPIKE_GAP) return;
                
                // check if SPIKE_LENGTH samples have passed since the candidate start, If so, add the spike buffer (containing SPIKE_LENGTH samples) to the spikes array
                if(count - start >= this.SPIKE_LENGTH) { 
                    
                    // Remove any spike candidates and mark this spike as the last spike
                    this.lastSpike[chIdx]       = count;

                    // Add the detected spike to the spikes array
                    this.spikes[chIdx].push(this.spikeBuffer[chIdx]);
                    return;
                }          
                
                // If spike has been detected, remove it from the spikes queue
                newSpikesQueue.push(start);
            })            

            this.spikesQueue[chIdx] = newSpikesQueue;            
            
        })

        // #######################################
        // TESTING ONLY
        const testIterations = 10000

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


        // ##############################
        // ###### PRE-PROCESSING ########
        
        // // Cast all values to floats
        // const buffer        = this.buffer.map(v => v.map(j => parseFloat(String(j))));       
        
        // const emptyChannels = Array.from(Array(this.NUM_CHANNELS).keys());

        // // Transpose the buffer array to separate the channels.     
        // const channels      = emptyChannels.map(chIdx => buffer.map(row => row[chIdx]));

        // // Apply high-pass filtering to the buffer
        // const filtered      = highPass(channels, 300, this.SAMPLE_RATE);                    

        // #############################
        // ####### COMPRESSION #########
        
        // this.detectSpikes(filtered);
                
        
        // if(isFirst) this.plots.push({ y: channels[0], type: 'scatter' })
        // if(isFirst) this.plots.push({ y: filtered[0], type: 'scatter' })
        // if(isFirst) this.plot();

        // ############################
        // ######## SENDING ###########
        // Send the data to the frontend for decompression


    /** Takes a buffer array containing C channels and generates an array of raw spike data */
    // detectSpikes = (channels: Buffer) => {
    //     const emptyChannels = Array.from(Array(this.NUM_CHANNELS).keys());
    //     const spikes        = emptyChannels.map(ch => [] as number[][]);        

    //     // Create an array of spikes by finding spikes that cross both thresholds
    //     channels.forEach((channel, chIdx) => {

    //         // Generate the thresholds from the standard deviation of the channel
    //         const THRESHOLD_1 = std(channel) * 0.8;
    //         const THRESHOLD_2 = std(channel) * 2.2;

    //         // Detect a spike
    //         channel.forEach((value, idx) => {                          

    //             // If the amount of time since the last spike is less than MIN_SPIKE_GAP, skip.
    //             if(idx - this.lastSpikeIdx < this.MIN_SPIKE_GAP) return;

    //             // Detect first threshold crossing
    //             if(!lastPass && value > THRESHOLD_1) lastPass = idx;

    //             // If first threshold has already been detected, detect the second crossing
    //             if(!lastPass) return;                            
    //             if(value > THRESHOLD_2) {
    //                 this.lastSpikeIdx   = idx;                    
                    
    //                 const spikeData     = channel.slice(lastPass, lastPass + this.SPIKE_LENGTH);
    //                 spikes[chIdx].push(spikeData);

    //                 return lastPass     = false;
    //             }

    //             // If the amount of samples since the first threshold is greater than the MAX_SPIKE_LENGTH then stop detecting second crossing.
    //             if(idx - lastPass > this.SPIKE_LENGTH)  return lastPass = false;                                

    //         })
    //     })
    // }

